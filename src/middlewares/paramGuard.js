import { z } from "zod";

// One schema, used everywhere. Normalizes docType to "ICA" | "NDA".
const accessSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  secret: z.string().min(8),
  docType: z
    .string()
    .transform((s) => (s ?? "").toString().trim().toUpperCase())
    .pipe(z.enum(["ICA", "NDA"])),
});

export function apiGuard(req, res, next) {
  try {
    // Pull from headers (client sends these on every request)
    const raw = {
      email: (req.header("x-esign-email") || "").toString(),
      name: (req.header("x-esign-name") || "").toString(),
      secret: (req.header("x-esign-secret") || "").toString(),
      docType: (req.header("x-esign-doctype") || "").toString(),
    };

    // Fallbacks (just in case) – accept query/body if header missing
    if (!raw.docType && req.query?.docType)
      raw.docType = String(req.query.docType);
    if (!raw.docType && req.body?.docType)
      raw.docType = String(req.body.docType);

    const parsed = accessSchema.parse(raw);

    if (parsed.secret !== process.env.SECRET_TOKEN) {
      return res
        .status(401)
        .json({ error: "Unauthorized", message: "Invalid secret" });
    }

    req.authz = parsed; // { email, name, secret, docType: "ICA" | "NDA" }
    next();
  } catch (err) {
    // Show clear message in dev
    if (process.env.NODE_ENV !== "production")
      console.error("apiGuard error:", err);
    const status = err?.issues ? 400 : 500;
    res.status(status).json(err);
  }
}
