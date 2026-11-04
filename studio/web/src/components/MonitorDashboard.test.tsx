import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { SampleViewer } from './MonitorDashboard'

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
