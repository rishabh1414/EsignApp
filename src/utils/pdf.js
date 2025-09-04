// src/utils/pdf.js
import { PDFDocument, rgb } from "pdf-lib";

/**
 * Stamp a PNG signature onto a specific page at given percentages.
 * opts = { page, xPct, yPct, widthPct }
 * - xPct, yPct are relative to the page width/height (0..1), measured from top-left.
 */
export async function stampSignatureAt(pdfBytes, sigPngBytes, opts) {
  const { page, xPct, yPct, widthPct } = opts;
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const png = await pdfDoc.embedPng(sigPngBytes);

  const pIndex = Math.max(1, page) - 1;
  const p =
    pdfDoc.getPages()[pIndex] ||
    pdfDoc.getPages()[pdfDoc.getPages().length - 1];

  const { width: pw, height: ph } = p.getSize();
  const targetW = Math.max(8, Math.min(pw, pw * widthPct));
  const scale = targetW / png.width;
  const targetH = png.height * scale;

  // Clamp x/y so the image stays in bounds
  const x = Math.max(0, Math.min(pw - targetW, Math.round(pw * xPct)));
  const yFromTop = Math.max(0, Math.min(ph - targetH, Math.round(ph * yPct)));
  // pdf-lib uses bottom-left origin; convert
  const y = ph - yFromTop - targetH;

  p.drawImage(png, { x, y, width: targetW, height: targetH });

  // (Optional) very light “Signed” mark you can remove if not needed
  // p.drawText('Signed', { x: 16, y: 16, size: 8, color: rgb(0.2,0.2,0.2) });

  return await pdfDoc.save();
}

// Backward-compat alias if other code imports bottom-right version
export const stampSignatureBottomRight = stampSignatureAt;
