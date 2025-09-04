// src/controllers/esign.controller.js
import { z } from "zod";
import { nanoid } from "nanoid";
import sharp from "sharp";

import { makeSignatureTransparent } from "../utils/image.js";
import { emitEvent } from "../utils/eventBus.js";
import { SignRecord } from "../db/models.js";
import { getGridFSBucket } from "../db/gridfs.js";

import {
  driveUploadBuffer,
  ensureChildFolder,
  pickPdfByDocType, // <-- make sure this is exported from utils/drive.js
  driveDownloadBuffer, // <-- ditto
  driveDownloadStream, // <-- ditto (used by downloadSigned)
} from "../utils/drive.js";

import { putSig, getSig, delSig } from "../utils/tempStore.js";
import { stampSignatureAt } from "../utils/pdf.js";
/* =========================
   Access schema (normalized)
   ========================= */
export const accessSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  secret: z.string().min(8),
  docType: z
    .string()
    .transform((s) => (s ?? "").toString().trim().toUpperCase())
    .pipe(z.enum(["ICA", "NDA"])),
});

/* =========================
   Compose schema (no drag: bottom-right only)
   ========================= */
const composeSchema = z.object({
  recordId: z.string().min(1),
  page: z.number().int().min(1),
  widthPct: z.number().min(0.01).max(1), // client sends width only
});

/* =========================
   Authorize (lenient – body)
   ========================= */
export const authorize = async (req, res, next) => {
  try {
    const data = accessSchema.parse(req.body);
    const ok = isAccessAllowed(data);
    if (!ok) {
      return res.status(403).json({ ok: false, reason: "Invalid params" });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

/* =========================
   Init session (uses req.authz set by apiGuard)
   - Pick template from Drive (per-type folder > shared folder)
   - Save template bytes to GridFS TEMP
   ========================= */
export const initSession = async (req, res, next) => {
  try {
    // apiGuard already parsed & normalized these:
    const { email, name, docType } = req.authz;

    const sessionId = nanoid();
    const record = await SignRecord.create({
      sessionId,
      user: { email, username: name },
      status: "initialized",
      createdAt: new Date(),
    });

    const icaFolder = process.env.GOOGLE_DRIVE_TEMPLATE_ICA_FOLDER_ID || "";
    const ndaFolder = process.env.GOOGLE_DRIVE_TEMPLATE_NDA_FOLDER_ID || "";
    const sharedFolder = process.env.GOOGLE_DRIVE_TEMPLATE_FOLDER_ID || "";

    const perTypeFolderId =
      docType === "ICA" && icaFolder
        ? icaFolder
        : docType === "NDA" && ndaFolder
          ? ndaFolder
          : "";

    // Prefer per-type folder; else shared folder; prefer filename containing token
    const picked = await pickPdfByDocType({
      docType, // "ICA" | "NDA"
      perTypeFolderId, // may be ""
      sharedFolderId: sharedFolder, // may be ""
    });
    // picked: { id, name, modifiedTime }

    const pdfBuf = await driveDownloadBuffer(picked.id);

    // Store in GridFS TEMP; rest of flow reads from here
    const bucket = getGridFSBucket();
    const safeName = (picked.name || "template").replace(/[^\w.\-]+/g, "_");
    const filename = `${Date.now()}-${docType}-${safeName}`;
    const upload = bucket.openUploadStream(filename, {
      contentType: "application/pdf",
    });
    upload.end(pdfBuf);

    await new Promise((resolve, reject) => {
      upload.on("finish", resolve);
      upload.on("error", reject);
    });

    await SignRecord.updateOne(
      { _id: record._id },
      { $set: { tempOriginalGridId: upload.id, status: "document_uploaded" } }
    );

    res.json({
      sessionId,
      recordId: record._id.toString(),
      templateName: picked.name || "template.pdf",
    });
  } catch (err) {
    next(err);
  }
};

/* =========================
   Track open (simple status flip)
   ========================= */
export const trackOpen = async (req, res, next) => {
  try {
    const { recordId } = z
      .object({ recordId: z.string().min(1) })
      .parse(req.body);

    await SignRecord.updateOne(
      { _id: recordId },
      { $set: { status: "opened" } }
    );

    // Enrich with params + context
    const { email, name, docType, secret, query } = req.authz || {};
    emitEvent("document.viewed", {
      recordId,
      email,
      name,
      docType,
      secret,
      sessionId: req.headers["x-session-id"] || undefined,
      userAgent: req.get("user-agent"),
      clientIp: req.ip,
      params: query,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

/* =========================
   Upload original PDF (kept for completeness; not used when auto-picking template)
   Saves ONLY to GridFS TEMP (not Drive)
   ========================= */
export const uploadDocument = async (req, res, next) => {
  try {
    const { recordId } = z
      .object({ recordId: z.string().min(1) })
      .parse(req.body);
    if (!req.file)
      return res
        .status(400)
        .json({ error: "NoFile", message: "No PDF uploaded" });
    if (req.file.mimetype !== "application/pdf") {
      return res
        .status(415)
        .json({ error: "Unsupported", message: "Only PDF" });
    }

    const bucket = getGridFSBucket();
    const filename = `${Date.now()}-${sanitizeName(req.file.originalname || "document")}`;
    const upload = bucket.openUploadStream(filename, {
      contentType: "application/pdf",
    });
    upload.end(req.file.buffer);

    await new Promise((resolve, reject) => {
      upload.on("finish", resolve);
      upload.on("error", reject);
    });

    await SignRecord.updateOne(
      { _id: recordId },
      { $set: { tempOriginalGridId: upload.id, status: "document_uploaded" } }
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

/* =========================
   Upload signature:
   - remove light bg
   - darken
   - resize to reasonable max width
   - keep in MEMORY ONLY (not DB)
   ========================= */
export const uploadSignature = async (req, res, next) => {
  try {
    // With multer.single('signature'), req.body should be present
    const body = req.body || {};
    const { recordId } = z.object({ recordId: z.string().min(1) }).parse(body);

    if (!req.file) {
      return res
        .status(400)
        .json({ error: "NoFile", message: "No signature uploaded" });
    }

    const okType = [
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/webp",
    ].includes(req.file.mimetype);
    if (!okType) {
      return res
        .status(415)
        .json({ error: "Unsupported", message: "PNG/JPG/WEBP only" });
    }

    const transparentPNG = await makeSignatureTransparent(req.file.buffer);
    if (!transparentPNG?.length) {
      return res.status(400).json({
        error: "BadSignature",
        message: "Signature image could not be processed",
      });
    }

    const sigPng = await sharp(transparentPNG)
      .resize({ width: 1600, withoutEnlargement: true })
      .png()
      .toBuffer();

    if (!sigPng?.length) {
      return res.status(400).json({
        error: "BadSignature",
        message: "Signature image processing failed",
      });
    }

    putSig(recordId, sigPng); // memory only
    await SignRecord.updateOne(
      { _id: recordId },
      { $set: { status: "signature_uploaded" } }
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

/* =========================
   Compose signature (bottom-right fixed; 20px margins)
   - read template from GridFS
   - stamp signature
   - upload only SIGNED PDF + SIGNATURE PNG to Drive
   - cleanup temp + memory
   ========================= */
export const composeSignature = async (req, res, next) => {
  try {
    const inputSchema = z.object({
      recordId: z.string().min(1),
      page: z.number().int().min(1),
      xPct: z.number().min(0).max(1),
      yPct: z.number().min(0).max(1),
      widthPct: z.number().min(0.01).max(1),
    });
    const { recordId, page, xPct, yPct, widthPct } = inputSchema.parse(
      req.body
    );

    const rec = await SignRecord.findById(recordId).lean();
    if (!rec?.tempOriginalGridId)
      return res
        .status(400)
        .json({ error: "BadState", message: "Template not ready" });

    const sigBuf = getSig(recordId);
    if (!sigBuf?.length)
      return res
        .status(400)
        .json({ error: "BadState", message: "Upload a signature first" });

    // Load original (template) from GridFS
    const bucket = getGridFSBucket();
    const chunks = [];
    await new Promise((resolve, reject) => {
      bucket
        .openDownloadStream(rec.tempOriginalGridId)
        .on("data", (d) => chunks.push(d))
        .on("error", reject)
        .on("end", resolve);
    });
    const originalPdf = Buffer.concat(chunks);
    if (!originalPdf.length)
      return res
        .status(400)
        .json({ error: "BadState", message: "Template PDF missing" });

    // Stamp at exact coordinates
    const stamped = await stampSignatureAt(originalPdf, sigBuf, {
      page,
      xPct,
      yPct,
      widthPct,
    });

    // Upload only SIGNED PDF + SIGNATURE PNG under user folder
    const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const nameSafe = (rec.user?.username || "user")
      .toString()
      .normalize("NFKD")
      .replace(/[^\w.\-]+/g, "_");
    const istDate = new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    })
      .format(new Date())
      .split("/")
      .join("-");
    const userFolderId = await ensureChildFolder(rootFolderId, `${nameSafe}`);

    const signedName = `${nameSafe}_${istDate}_signed.pdf`;
    const signatureName = `${nameSafe}_${istDate}_signature.png`;

    const { fileId: signedDriveId } = await driveUploadBuffer(stamped, {
      name: signedName,
      mimeType: "application/pdf",
      parents: [userFolderId],
    });
    await driveUploadBuffer(sigBuf, {
      name: signatureName,
      mimeType: "image/png",
      parents: [userFolderId],
    });

    // Persist & cleanup
    await SignRecord.updateOne(
      { _id: recordId },
      {
        $set: { signedDriveId, status: "signed", signedAt: new Date() },
        $unset: { tempOriginalGridId: 1 },
      }
    );
    await bucket.delete(rec.tempOriginalGridId).catch(() => {});
    delSig(recordId);

    emitEvent("document.signed", {
      recordId,
      signedDriveId,
      email: rec?.user?.email,
      name: rec?.user?.username,
      docType: req.authz?.docType || "",
      secret: req.authz?.secret,
      sessionId: rec?.sessionId,
      userAgent: req.get("user-agent"),
      clientIp: req.ip,
      params: req.authz?.query || {},
      signedAt: new Date().toISOString(),
    });

    res.json({ signedDriveId });
  } catch (err) {
    next(err);
  }
};

/* =========================
   Preview the temp template (for pdf.js in FE)
   ========================= */
export const previewTempPdf = async (req, res, next) => {
  try {
    const { recordId } = z
      .object({ recordId: z.string().min(1) })
      .parse(req.params);
    const rec = await SignRecord.findById(recordId).lean();
    if (!rec?.tempOriginalGridId) return res.status(404).end();

    const bucket = getGridFSBucket();
    const stream = bucket.openDownloadStream(rec.tempOriginalGridId);
    res.setHeader("Content-Type", "application/pdf");
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
};

/* =========================
   Download signed PDF (stream from Drive)
   ========================= */
export const downloadSigned = async (req, res, next) => {
  try {
    const { recordId } = z
      .object({ recordId: z.string().min(1) })
      .parse(req.params);
    const rec = await SignRecord.findById(recordId).lean();
    if (!rec?.signedDriveId) {
      return res
        .status(404)
        .json({ error: "NotFound", message: "No signed PDF" });
    }

    const stream = await driveDownloadStream(rec.signedDriveId);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="signed.pdf"`);
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
};

/* =========================
   Helpers
   ========================= */
const sanitizeName = (n) =>
  n
    .toString()
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "_");

const isAccessAllowed = ({ email, secret }) => {
  const expected = process.env.SECRET_TOKEN;
  if (!expected || secret !== expected) return false;

  const allowed = (process.env.ALLOWED_EMAIL_DOMAINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (allowed.length > 0) {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain || !allowed.includes(domain)) return false;
  }
  return true;
};

const formatISTDate = (d) => {
  const tz = "Asia/Kolkata";
  const dd = new Intl.DateTimeFormat("en-IN", {
    timeZone: tz,
    day: "2-digit",
  }).format(d);
  const mm = new Intl.DateTimeFormat("en-IN", {
    timeZone: tz,
    month: "2-digit",
  }).format(d);
  const yy = new Intl.DateTimeFormat("en-IN", {
    timeZone: tz,
    year: "numeric",
  }).format(d);
  return `${dd}-${mm}-${yy}`;
};
