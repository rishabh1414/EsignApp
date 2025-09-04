import { Router } from "express";
import multer from "multer";
import { apiGuard } from "../middlewares/paramGuard.js";
import {
  authorize,
  initSession,
  trackOpen,
  uploadSignature,
  composeSignature,
  previewTempPdf,
  downloadSigned,
} from "../controllers/esign.controller.js";

const router = Router();
const upload = multer(); // memory storage

router.post("/authorize", authorize);
router.post("/session/init", apiGuard, initSession);
router.post("/session/open", apiGuard, trackOpen);

// 👇 Multer must run BEFORE the controller so req.body / req.file exist
router.post(
  "/upload/signature",
  apiGuard,
  upload.single("signature"),
  uploadSignature
);

router.post("/compose", apiGuard, composeSignature);
router.get("/session/pdf/:recordId", apiGuard, previewTempPdf);
router.get("/:recordId/download", apiGuard, downloadSigned);

export default router;
