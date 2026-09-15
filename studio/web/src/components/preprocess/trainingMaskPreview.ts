/** Persisted training-mask preview semantics shared by preprocess and read-only viewers. */
export const TRAINING_MASK_COLOR = '#ff2d2d'
export const TRAINING_MASK_VIEW_ALPHA = 0.45

/** Server mask pixels are grayscale (255 = learn, 0 = ignore). Convert them to
 * the red alpha layer used by the preprocess canvas. */
export function applyTrainingMaskPreviewPixels(pixels: Uint8ClampedArray): void {
  for (let i = 0; i < pixels.length; i += 4) {
    const value = pixels[i]
    pixels[i] = 255
    pixels[i + 1] = 45
    pixels[i + 2] = 45
    pixels[i + 3] = 255 - value
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`image load failed: ${url}`))
    image.src = url
  })
}

/** Load a persisted grayscale mask into a red alpha canvas. A missing or
 * undecodable mask deliberately resolves to null so image viewing still works. */
export async function loadTrainingMaskPreview(
  url: string,
  width?: number,
  height?: number,
): Promise<HTMLCanvasElement | null> {
  let image: HTMLImageElement
  try {
    image = await loadImage(url)
  } catch {
    return null
  }

  const targetWidth = width ?? image.naturalWidth
  const targetHeight = height ?? image.naturalHeight
  if (targetWidth <= 0 || targetHeight <= 0) return null

  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(image, 0, 0, targetWidth, targetHeight)
  const data = context.getImageData(0, 0, targetWidth, targetHeight)
  applyTrainingMaskPreviewPixels(data.data)
  context.putImageData(data, 0, 0)
  return canvas
}
