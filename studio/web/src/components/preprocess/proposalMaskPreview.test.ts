import { describe, expect, it } from 'vitest'
import { mergeProposalBitmap } from './proposalMaskPreview'
import { maskConfiguration, needsMaskReview } from './autoMaskReview'
import type { HeadMaskProposalImage } from '../../api/client'

describe('combined mask preview', () => {
  it('uses the strongest ignore value, not alpha blending, in either order', () => {
    const bitmap = (weights: number[]) => ({ width: 2, height: 1,
      data: new Uint8ClampedArray(weights.flatMap((w) => [w, w, w, 255])) })
    const a = bitmap([128, 255]), b = bitmap([100, 0])
    for (const order of [[a, b], [b, a], [a, a, b]]) {
      const pixels = new Uint8ClampedArray(4 * 3 * 4)
      for (const item of order) mergeProposalBitmap(pixels, 4, 3, item, [1, 1])
      expect(pixels[(1 * 4 + 1) * 4 + 3]).toBe(155)
      expect(pixels[(1 * 4 + 2) * 4 + 3]).toBe(255)
      expect(pixels[3]).toBe(0)
    }
    expect(() => mergeProposalBitmap(new Uint8ClampedArray(4), 1, 1, a, [0, 0])).toThrow()
  })

  it('finds a failed face even when background succeeded, but accepts an empty background', () => {
    const image = { regions: [{}], target_statuses: {
      background: { status: 'done', reason: 'ready', count: 1 },
      face_contour: { status: 'failed', reason: 'detection_failed', count: 0 },
    } } as HeadMaskProposalImage
    expect(needsMaskReview(image)).toBe(true)
    expect(needsMaskReview({ ...image, regions: [], target_statuses: {
      background: { status: 'empty', reason: 'no_background', count: 0 },
    } })).toBe(false)
  })

  it('ignores target order and unused parameters when checking for stale settings', () => {
    const base = { confidence: .4, iou_threshold: .7, padding_ratio: .1, feather_ratio: .03 }
    expect(maskConfiguration({ ...base, mask_targets: ['background'], confidence: .8 }))
      .toBe(maskConfiguration({ ...base, mask_targets: ['background'] }))
    expect(maskConfiguration({ ...base, mask_targets: ['face_contour', 'background'] }))
      .toBe(maskConfiguration({ ...base, mask_targets: ['background', 'face_contour'] }))
    expect(maskConfiguration({ ...base, mask_targets: ['background'], background_threshold: .6 }))
      .not.toBe(maskConfiguration({ ...base, mask_targets: ['background'] }))
  })
})
