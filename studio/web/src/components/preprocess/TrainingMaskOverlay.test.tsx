import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TrainingMaskOverlay from './TrainingMaskOverlay'
import { loadTrainingMaskPreview } from './trainingMaskPreview'

vi.mock('./trainingMaskPreview', () => ({
  TRAINING_MASK_VIEW_ALPHA: 0.45,
  loadTrainingMaskPreview: vi.fn(),
}))

function previewCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

describe('TrainingMaskOverlay', () => {
  const drawImage = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D)
  })

  it('ignores a completed load after the source has changed', async () => {
    let resolveOld!: (value: HTMLCanvasElement | null) => void
    let resolveNew!: (value: HTMLCanvasElement | null) => void
    vi.mocked(loadTrainingMaskPreview)
      .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveNew = resolve }))

    const view = render(<TrainingMaskOverlay src="/old.mask" />)
    const target = view.container.querySelector('canvas') as HTMLCanvasElement
    view.rerender(<TrainingMaskOverlay src="/new.mask" />)

    await act(async () => resolveOld(previewCanvas(10, 10)))
    expect(drawImage).not.toHaveBeenCalled()
    expect(target.style.visibility).toBe('hidden')

    const current = previewCanvas(20, 30)
    await act(async () => resolveNew(current))
    expect(drawImage).toHaveBeenCalledWith(current, 0, 0)
    expect(target.width).toBe(20)
    expect(target.height).toBe(30)
    expect(target.style.visibility).toBe('visible')
  })

  it('stays transparent when the persisted mask cannot be loaded', async () => {
    vi.mocked(loadTrainingMaskPreview).mockResolvedValueOnce(null)
    const view = render(<TrainingMaskOverlay src="/missing.mask" />)
    const target = view.container.querySelector('canvas') as HTMLCanvasElement

    await waitFor(() => expect(loadTrainingMaskPreview).toHaveBeenCalledWith('/missing.mask'))
    expect(drawImage).not.toHaveBeenCalled()
    expect(target.style.visibility).toBe('hidden')
  })
})
