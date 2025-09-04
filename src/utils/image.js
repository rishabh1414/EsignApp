import sharp from "sharp";

/**
 * Remove white/light background and preserve dark strokes.
 * Returns a darkened PNG with alpha.
 */
export const makeSignatureTransparent = async (inputBuffer) => {
  if (!inputBuffer || inputBuffer.length === 0) return Buffer.alloc(0);

  // Normalize to RGB PNG
  const base = await sharp(inputBuffer).removeAlpha().png().toBuffer();

  // Build alpha: invert grayscale, boost mid-tones, light denoise
  const inv = await sharp(base)
    .greyscale()
    .negate()
    .gamma(1.7) // valid range 1..3
    .linear(1.25, -10) // gentle contrast
    .median(1)
    .toBuffer();

  const { width, height } = await sharp(base).metadata();
  const alpha = await sharp(inv)
    .resize({ width, height })
    .toColourspace("b-w")
    .toBuffer();

  // Slightly darken RGB so strokes are bolder after masking
  const darkRGB = await sharp(base).linear(1.2, -8).toBuffer();

  return await sharp(darkRGB).joinChannel(alpha).png().toBuffer();
};
