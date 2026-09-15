import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DuplicateScanResult } from '../api/client'
import DuplicateReviewPanel from './DuplicateReviewPanel'

const result: DuplicateScanResult = {
  target: 'preprocess',
  match_scope: 'both',
  total_images: 2,
  readable_images: 2,
  group_count: 1,
  candidate_count: 1,
  crop_relation_count: 0,
  elapsed_seconds: 0.1,
  stats: {
    total_pairs: 1,
    aspect_skipped_pairs: 0,
    prefiltered_pairs: 1,
    compared_pairs: 1,
  },
  groups: [{
    group_id: 1,
    keep: '1_data/keep.png',
    best: null,
    items: [
      { name: '1_data/keep.png', keep: true, width: 512, height: 512, filesize_kb: 100, metrics: null },
      { name: '1_data/remove.png', keep: false, width: 512, height: 512, filesize_kb: 90, metrics: null },
    ],
  }],
}

describe('DuplicateReviewPanel image selection', () => {
  it('adds the shared frame only to removal selections and keeps warning/keep card tones', () => {
    render(
      <DuplicateReviewPanel
        projectId={1}
        versionId={2}
        result={result}
        selected={new Set(['1_data/remove.png'])}
        busy={false}
        onSelect={vi.fn()}
        onPreview={vi.fn()}
      />
    )

    const keepPreview = screen.getByAltText('1_data/keep.png').closest('button')
    const removePreview = screen.getByAltText('1_data/remove.png').closest('button')
    expect(keepPreview?.querySelector('.ui-image-selection-frame')).not.toBeInTheDocument()
    expect(removePreview?.querySelector('.ui-image-selection-frame')).toBeInTheDocument()
    expect(keepPreview?.parentElement).toHaveClass('border-ok')
    expect(removePreview?.parentElement).toHaveClass('border-warn')
  })
})
