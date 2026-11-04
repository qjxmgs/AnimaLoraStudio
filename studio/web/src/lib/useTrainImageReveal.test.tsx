import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, makeApiError } from '../api/client'
import { useTrainImageReveal } from './useTrainImageReveal'

const mocks = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('../components/Toast', () => ({ useOptionalToast: () => ({ toast: mocks.toast }) }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('useTrainImageReveal', () => {
  it('prevents repeated clicks from opening duplicate windows while a request is in flight', async () => {
    let complete!: (value: { revealed: true }) => void
    const reveal = vi.spyOn(api, 'revealTrainImage').mockReturnValue(new Promise((resolve) => { complete = resolve }))
    const { result } = renderHook(() => useTrainImageReveal(4, 9))
    const first = result.current('2_other/a.png')
    await result.current('1_data/b.png')
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(reveal).toHaveBeenCalledWith(4, 9, '2_other/a.png')
    await act(async () => { complete({ revealed: true }); await first })
    await result.current('1_data/b.png')
    expect(reveal).toHaveBeenCalledTimes(2)
  })

  it('reports a localized failure and allows a subsequent retry', async () => {
    const error = makeApiError(500, 'Internal Server Error', {
      error: { code: 'system.reveal_failed', message: 'Shell failed' },
    })
    const reveal = vi.spyOn(api, 'revealTrainImage').mockRejectedValueOnce(error).mockResolvedValue({ revealed: true })
    const { result } = renderHook(() => useTrainImageReveal(4, 9))
    await result.current('1_data/a.png')
    expect(mocks.toast).toHaveBeenCalledWith('无法在文件资源管理器中定位图片，请重试', 'error')
    await result.current('1_data/a.png')
    expect(reveal).toHaveBeenCalledTimes(2)
  })
})
