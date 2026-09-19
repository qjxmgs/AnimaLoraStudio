/** Merge grayscale loss weights into an ignore-alpha layer using pixelwise max.
 * This is the exact inverse of the server's pixelwise-min loss-mask merge. */
export function mergeProposalBitmap(
  pixels: Uint8ClampedArray, width: number, height: number,
  bitmap: Pick<ImageData, 'data' | 'width' | 'height'>, origin: [number, number],
): void {
  const [left, top] = origin
  if (left < 0 || top < 0 || left + bitmap.width > width || top + bitmap.height > height) {
    throw new Error('Mask bitmap is outside the source image')
  }
  for (let y = 0; y < bitmap.height; y++) {
    for (let x = 0; x < bitmap.width; x++) {
      const source = (y * bitmap.width + x) * 4
      const dest = ((y + top) * width + x + left) * 4
      pixels[dest + 3] = Math.max(pixels[dest + 3], 255 - bitmap.data[source])
    }
  }
}
