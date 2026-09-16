import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import InpaintToolPanel from './InpaintToolPanel'

describe('InpaintToolPanel', () => {
  it('keeps supplemental content scrollable and pins footer actions outside it', () => {
    render(
      <InpaintToolPanel
        mode="mask"
        setMode={vi.fn()}
        tool="lasso"
        setTool={vi.fn()}
        brush={{ color: '#ffffff', size: 24, hardness: 1 }}
        setBrush={vi.fn()}
        recentColors={[]}
        footer={<button type="button">Pinned action</button>}
      >
        <span>Scrollable extension</span>
      </InpaintToolPanel>,
    )

    const scroll = screen.getByTestId('inpaint-tool-panel-scroll')
    const footer = screen.getByTestId('inpaint-tool-panel-footer')
    expect(scroll).toContainElement(screen.getByText('Scrollable extension'))
    expect(scroll).not.toContainElement(footer)
    expect(footer).toContainElement(screen.getByRole('button', { name: 'Pinned action' }))
    expect(footer).toHaveClass('shrink-0', 'border-t')
  })
})
