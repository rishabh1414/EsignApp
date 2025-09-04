import "dotenv/config";
import { google } from "googleapis";
import stream from "node:stream";

function loadPrivateKey() {
  const b64 = process.env.GOOGLE_PRIVATE_KEY_BASE64;
  if (b64) return Buffer.from(b64, "base64").toString("utf8");
  let k = process.env.GOOGLE_PRIVATE_KEY || "";
  return k.includes("\\n") ? k.replace(/\\n/g, "\n") : k;
}

const auth = new google.auth.JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: loadPrivateKey(),
  scopes:
    process.env.GOOGLE_DRIVE_SCOPE || "https://www.googleapis.com/auth/drive",
});
const drive = google.drive({ version: "v3", auth });

const folderId = (process.env.GOOGLE_DRIVE_FOLDER_ID || "").trim();

function bufferToStream(buf) {
  const pass = new stream.PassThrough();
  pass.end(buf);
  return pass;
}

(async () => {
  // 1) Verify folder
  const meta = await drive.files.get({
    fileId: folderId,
    fields: "id,name,mimeType,driveId,capabilities(canAddChildren),parents",
    supportsAllDrives: true,
  });
  console.log("Folder metadata:", meta.data);

  // 2) Create a tiny file (use a Readable stream)
  const body = bufferToStream(Buffer.from("hello from esign check\n"));
  const { data } = await drive.files.create({
    requestBody: {
      name: `esign-check-${Date.now()}.txt`,
      parents: [folderId],
      mimeType: "text/plain",
    },
    media: { mimeType: "text/plain", body },
    fields: "id,name,parents",
    supportsAllDrives: true,
  });
  console.log("Created test file:", data);
})().catch((e) => {
  console.error("Drive check failed:", e.response?.data || e.message || e);
  process.exit(1);
});
