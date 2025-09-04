import { describe, it, expect } from "vitest";
import { stampSignatureOnPdf } from "../src/utils/pdf.js";
import fs from "node:fs";

describe("PDF stamping", () => {
  it("stamps a PNG onto a sample PDF", async () => {
    const pdf = fs.readFileSync(__dirname + "/fixtures/sample.pdf"); // add your own fixture
    const sig = fs.readFileSync(__dirname + "/fixtures/signature.png");
    const out = await stampSignatureOnPdf(pdf, sig, {
      page: 1,
      xPct: 0.5,
      yPct: 0.5,
      widthPct: 0.3,
    });
    expect(out.byteLength).toBeGreaterThan(pdf.byteLength);
  });
});
