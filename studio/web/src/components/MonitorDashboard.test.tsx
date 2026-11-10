import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { SampleViewer, TrainingMaskStatus } from './MonitorDashboard'

it('shows mask enablement, effective count, empty masks and legacy unknown states', () => {
  const { rerender } = render(<TrainingMaskStatus />)
  expect(screen.getByText('未记录')).toBeInTheDocument()
  rerender(<TrainingMaskStatus config={{ masked_loss_enabled: true, mask_status_ready: false }} />)
  expect(screen.getByText('已启用')).toBeInTheDocument()
  expect(screen.getByText('等待数据检查')).toBeInTheDocument()
  rerender(<TrainingMaskStatus config={{ masked_loss_enabled: true, mask_status_ready: true, mask_used_images: 15, mask_total_images: 15 }} />)
  expect(screen.getByText('实际使用 15 / 15 张')).toBeInTheDocument()
  rerender(<TrainingMaskStatus config={{ masked_loss_enabled: true, mask_status_ready: true, mask_used_images: 0, mask_total_images: 15 }} />)
  expect(screen.getByText('已启用 · 未生效')).toBeInTheDocument()
  rerender(<TrainingMaskStatus config={{ masked_loss_enabled: false, mask_status_ready: true, mask_used_images: 0, mask_total_images: 15 }} />)
  expect(screen.getByText('未启用')).toBeInTheDocument()
  expect(screen.getByText('实际使用 0 / 15 张')).toBeInTheDocument()
  rerender(<TrainingMaskStatus config={{ masked_loss_enabled: true, mask_status_ready: false, mask_status_error: true }} />)
  expect(screen.getByText('遮罩数量统计失败')).toBeInTheDocument()
})

it('navigates training samples with A/D in the strip and enlarged preview', () => {
  const previous = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = vi.fn()
  try {
    render(<><input aria-label="filter" /><SampleViewer taskId={73}
      samples={[{ path: 'first.png' }, { path: 'second.png' }, { path: 'third.png' }]} /></>)
    const active = () => screen.getByRole('img', { name: 'sample preview' }).getAttribute('src')
    fireEvent.keyDown(screen.getByLabelText('filter'), { key: 'a' })
    expect(active()).toContain('third.png')
    fireEvent.keyDown(window, { key: 'a' })
    expect(active()).toContain('second.png')
    fireEvent.keyDown(window, { key: 'd' })
    expect(active()).toContain('third.png')
    fireEvent.click(screen.getByRole('img', { name: 'sample preview' }))
    const preview = screen.getByRole('dialog')
    fireEvent.keyDown(preview, { key: 'a' })
    expect(active()).toContain('second.png')
    fireEvent.keyDown(preview, { key: 'd' })
    fireEvent.keyDown(preview, { key: 'd' })
    expect(active()).toContain('third.png')
  } finally {
    if (previous) HTMLElement.prototype.scrollIntoView = previous
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  }
})
