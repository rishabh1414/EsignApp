// src/utils/drive.js
import { google } from "googleapis";
import stream from "node:stream";

function loadPrivateKey() {
  const b64 = process.env.GOOGLE_PRIVATE_KEY_BASE64;
  if (b64) return Buffer.from(b64, "base64").toString("utf8");
  let k = process.env.GOOGLE_PRIVATE_KEY || "";
  return k.includes("\\n") ? k.replace(/\\n/g, "\n") : k;
}

function getDrive() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = loadPrivateKey();
  const scopes = (
    process.env.GOOGLE_DRIVE_SCOPE ||
    "https://www.googleapis.com/auth/drive.file"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes,
  });
  return google.drive({ version: "v3", auth });
}

async function assertFolderUsable(drive, folderIdRaw) {
  const folderId = (folderIdRaw || "").trim();
  if (!folderId) throw new Error("GOOGLE_DRIVE_FOLDER_ID is empty");

  const { data } = await drive.files.get({
    fileId: folderId,
    fields: "id,name,mimeType,driveId,capabilities(canAddChildren),parents",
    supportsAllDrives: true,
  });

  if (data.mimeType !== "application/vnd.google-apps.folder") {
    throw new Error(
      `GOOGLE_DRIVE_FOLDER_ID is not a folder (mimeType=${data.mimeType})`
    );
  }
  if (data.capabilities && data.capabilities.canAddChildren === false) {
    throw new Error(
      "Service account cannot add children in this folder (permission issue)"
    );
  }
  return data; // useful for debugging
}

export async function driveUploadBuffer(buffer, { name, mimeType, parents }) {
  const drive = getDrive();
  // Validate parent folder (first element)
  await assertFolderUsable(
    drive,
    (parents && parents[0]) || process.env.GOOGLE_DRIVE_FOLDER_ID
  );

  const body = new stream.PassThrough();
  body.end(buffer);

  const { data } = await drive.files.create({
    requestBody: {
      name: name.trim(),
      parents: [
        (parents && parents[0]) || process.env.GOOGLE_DRIVE_FOLDER_ID.trim(),
      ],
      mimeType,
    },
    media: { mimeType, body },
    fields: "id,name,webViewLink,webContentLink",
    supportsAllDrives: true,
  });
  return {
    fileId: data.id,
    name: data.name,
    webViewLink: data.webViewLink,
    webContentLink: data.webContentLink,
  };
}

export async function driveGetMetadata(fileId) {
  const drive = getDrive();
  const { data } = await drive.files.get({
    fileId: (fileId || "").trim(),
    fields: "id,name,mimeType,driveId,parents,modifiedTime",
    supportsAllDrives: true,
  });
  return data;
}

export async function driveDownloadFile(fileId) {
  const drive = getDrive();
  const res = await drive.files.get(
    { fileId: (fileId || "").trim(), alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}

export async function driveDownloadStream(fileId) {
  const drive = getDrive();
  const { data } = await drive.files.get(
    { fileId: (fileId || "").trim(), alt: "media", supportsAllDrives: true },
    { responseType: "stream" }
  );
  return data;
}
export async function ensureChildFolder(parentId, folderName) {
  const drive = getDrive();
  const name = folderName.trim();
  // Try to find existing
  const { data } = await drive.files.list({
    q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
    fields: "files(id,name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: await getDriveId(parentId),
  });
  if (data.files && data.files[0]) return data.files[0].id;

  // Create if not found
  const created = await drive.files.create({
    requestBody: {
      name,
      parents: [parentId],
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id",
    supportsAllDrives: true,
  });
  return created.data.id;
}

async function getDriveId(fileOrFolderId) {
  const drive = getDrive();
  const meta = await drive.files.get({
    fileId: fileOrFolderId.trim(),
    fields: "driveId",
    supportsAllDrives: true,
  });
  return meta.data.driveId;
}
// add near your other imports/helpers
export async function pickLatestPdfFromFolder(folderId) {
  const drive = getDrive();
  const { data } = await drive.files.list({
    q: `'${folderId}' in parents and mimeType='application/pdf' and trashed=false`,
    fields: "files(id,name,modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: 50,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (!data.files || !data.files.length)
    throw new Error("No PDF found in template folder");
  return data.files[0]; // { id, name, modifiedTime }
}

export async function pickPdfByDocType({
  docType,
  perTypeFolderId,
  sharedFolderId,
}) {
  const folderId = perTypeFolderId || sharedFolderId;
  if (!folderId) throw new Error("Template folder ID missing for " + docType);

  const drive = getDrive();
  const { data } = await drive.files.list({
    q: `'${folderId}' in parents and mimeType='application/pdf' and trashed=false`,
    fields: "files(id,name,modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = data.files || [];
  if (!files.length) throw new Error("No PDF found in template folder");

  // Try to find by name containing the docType token (case-insensitive)
  const token = (docType || "").toLowerCase(); // "ica" or "nda"
  const preferred = files.find((f) =>
    (f.name || "").toLowerCase().includes(token)
  );
  return preferred || files[0]; // fall back to latest
}

export async function driveDownloadBuffer(fileId) {
  const drive = getDrive();
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}
