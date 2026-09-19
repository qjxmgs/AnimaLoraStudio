import type { HeadMaskProposalImage, HeadMaskProposals, MaskTarget } from '../../api/client'

export const MASK_TARGETS: MaskTarget[] = ['face_contour', 'head_box', 'background']
export const MASK_MODEL_LABELS = {
  head_detector: 'downloadModel', face_segmenter: 'prepareFaceModel', background_segmenter: 'downloadBackgroundModel',
} as const

export function proposalTargets(params: HeadMaskProposals['parameters']): MaskTarget[] {
  return params.mask_targets ?? [params.mask_mode ?? 'head_box']
}

export function needsMaskReview(image: HeadMaskProposalImage): boolean {
  if (image.target_statuses) {
    return Object.values(image.target_statuses).some((status) => status
      && status.status !== 'done' && status.reason !== 'no_background')
  }
  return image.regions.length === 0 || image.review_status === 'needs_review'
}

/** Compare only parameters used by the requested targets; hidden fields do not invalidate results. */
export function maskConfiguration(params: HeadMaskProposals['parameters']): string {
  const targets = proposalTargets(params)
  return JSON.stringify({
    targets: MASK_TARGETS.filter((target) => targets.includes(target)),
    head: targets.some((t) => t !== 'background') ? [params.confidence, params.iou_threshold] : null,
    box: targets.includes('head_box') ? [params.padding_ratio, params.feather_ratio] : null,
    face: targets.includes('face_contour')
      ? [params.face_confidence ?? .25, params.mask_threshold ?? .5, params.feather_px ?? 0] : null,
    background: targets.includes('background')
      ? [params.background_threshold ?? .5, params.background_protect_px ?? 0, params.background_feather_px ?? 0] : null,
  })
}
