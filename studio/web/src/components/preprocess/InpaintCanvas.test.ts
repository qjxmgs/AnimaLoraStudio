import { describe, expect, it, vi } from 'vitest'
import { applyAutoMaskRegions, traceLassoPath, type LassoShape } from './InpaintCanvas'
import {
  applyTrainingMaskPreviewPixels,
  TRAINING_MASK_COLOR,
  TRAINING_MASK_VIEW_ALPHA,
} from './trainingMaskPreview'

describe('training mask preview', () => {
  it('maps grayscale learning weights to the shared red ignore overlay', () => {
    const pixels = new Uint8ClampedArray([
      0, 0, 0, 255,
      128, 128, 128, 255,
      255, 255, 255, 255,
    ])

    applyTrainingMaskPreviewPixels(pixels)

    expect([...pixels]).toEqual([
      255, 45, 45, 255,
      255, 45, 45, 127,
      255, 45, 45, 0,
    ])
    expect(TRAINING_MASK_COLOR).toBe('#ff2d2d')
    expect(TRAINING_MASK_VIEW_ALPHA).toBe(0.45)
  })
})

describe('automatic mask rasterization', () => {
  it('uses the exact rectangular interior and independent x/y feather distances', () => {
    const width = 6
    const height = 6
    const pixels = new Uint8ClampedArray(width * height * 4)
    applyAutoMaskRegions(pixels, width, height, [
      { x1: 2, y1: 2, x2: 4, y2: 4, feather_x: 2, feather_y: 1 },
    ])
    const alpha = (x: number, y: number) => pixels[(y * width + x) * 4 + 3]

    expect(alpha(2, 2)).toBe(255)
    expect(alpha(3, 3)).toBe(255)
    expect(alpha(1, 2)).toBe(128)
    expect(alpha(0, 2)).toBe(0)
    expect(alpha(2, 1)).toBe(0)
    expect(alpha(4, 2)).toBe(128)
    expect(alpha(5, 2)).toBe(0)
  })

  it('unions overlapping automatic regions without weakening an existing mask', () => {
    const width = 5
    const height = 3
    const pixels = new Uint8ClampedArray(width * height * 4)
    pixels[(1 * width + 1) * 4 + 3] = 220
    applyAutoMaskRegions(pixels, width, height, [
      { x1: 2, y1: 1, x2: 3, y2: 2, feather_x: 2, feather_y: 0 },
      { x1: 3, y1: 1, x2: 4, y2: 2, feather_x: 1, feather_y: 0 },
    ])
    const alpha = (x: number, y: number) => pixels[(y * width + x) * 4 + 3]

    expect(alpha(1, 1)).toBe(220)
    expect(alpha(2, 1)).toBe(255)
    expect(alpha(3, 1)).toBe(255)
    expect(alpha(4, 1)).toBe(0)
  })
})

describe('lasso path geometry', () => {
  it('keeps corner segments straight and curves both sides of a smooth anchor', () => {
    const context = {
      beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
      bezierCurveTo: vi.fn(), closePath: vi.fn(),
    }
    const shape: LassoShape = {
      id: 'shape', color: '#ffffff',
      points: [
        { id: 'a', x: 0, y: 0, smooth: false },
        { id: 'b', x: 60, y: 0, smooth: true },
        { id: 'c', x: 60, y: 60, smooth: false },
        { id: 'd', x: 0, y: 60, smooth: false },
      ],
    }

    expect(traceLassoPath(context, shape)).toBe(true)
    expect(context.bezierCurveTo).toHaveBeenCalledTimes(2)
    expect(context.lineTo).toHaveBeenCalledTimes(2)
    expect(context.closePath).toHaveBeenCalledTimes(1)
    expect(context.bezierCurveTo).toHaveBeenNthCalledWith(
      1, 0, 0, 50, -10, 60, 0,
    )
    expect(context.bezierCurveTo).toHaveBeenNthCalledWith(
      2, 70, 10, 60, 60, 60, 60,
    )
  })

  it('rejects an open shape with fewer than three anchors', () => {
    const context = {
      beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
      bezierCurveTo: vi.fn(), closePath: vi.fn(),
    }
    expect(traceLassoPath(context, {
      id: 'short', color: '#ffffff',
      points: [
        { id: 'a', x: 0, y: 0, smooth: false },
        { id: 'b', x: 1, y: 1, smooth: false },
      ],
    })).toBe(false)
    expect(context.beginPath).not.toHaveBeenCalled()
  })
})
