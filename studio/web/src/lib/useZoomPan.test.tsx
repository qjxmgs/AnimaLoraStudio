import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useZoomPan } from './useZoomPan'

function pointerEvent(
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: MouseEventInit & { pointerId?: number } = {},
) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 })
  return event
}

function Harness() {
  const zp = useZoomPan({
    contentW: 400,
    contentH: 300,
    spacePanScope: 'viewport',
  })
  return (
    <div>
      <button type="button">Outside control</button>
      <input aria-label="Outside input" />
      <div
        ref={zp.wrapRef}
        data-testid="viewport"
        tabIndex={0}
        style={{ cursor: zp.isPanning ? 'grabbing' : zp.spacePressed ? 'grab' : 'crosshair' }}
        {...zp.handlers}
      >
        <div
          ref={(element) => { zp.contentRef.current = element }}
          data-testid="content"
        />
      </div>
      <output data-testid="state">
        {zp.spacePressed ? 'space' : 'idle'}:{zp.isPanning ? 'panning' : 'still'}
      </output>
    </div>
  )
}

describe('useZoomPan viewport-scoped space pan', () => {
  afterEach(() => vi.restoreAllMocks())

  function renderHarness() {
    Object.defineProperty(Element.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    })
    render(<Harness />)
    return {
      viewport: screen.getByTestId('viewport'),
      content: screen.getByTestId('content'),
      state: screen.getByTestId('state'),
    }
  }

  it('only captures unmodified Space while the viewport is active', () => {
    const { viewport, state } = renderHarness()
    const outsideDown = new KeyboardEvent('keydown', {
      code: 'Space', bubbles: true, cancelable: true,
    })
    fireEvent(window, outsideDown)
    expect(outsideDown.defaultPrevented).toBe(false)
    expect(state).toHaveTextContent('idle:still')

    fireEvent.keyUp(window, { code: 'Space' })
    fireEvent.pointerEnter(viewport)
    const activeDown = new KeyboardEvent('keydown', {
      code: 'Space', bubbles: true, cancelable: true,
    })
    fireEvent(window, activeDown)
    expect(activeDown.defaultPrevented).toBe(true)
    expect(state).toHaveTextContent('space:still')
    expect(viewport).toHaveStyle({ cursor: 'grab' })

    fireEvent.keyUp(window, { code: 'Space' })
    fireEvent.keyDown(window, { code: 'Space', ctrlKey: true })
    expect(state).toHaveTextContent('idle:still')
  })

  it('does not take Space from an interactive control', () => {
    const { viewport, state } = renderHarness()
    const input = screen.getByRole('textbox', { name: 'Outside input' })
    fireEvent.pointerEnter(viewport)
    input.focus()
    const down = new KeyboardEvent('keydown', {
      code: 'Space', bubbles: true, cancelable: true,
    })
    input.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(false)
    expect(state).toHaveTextContent('idle:still')
  })

  it('latches a left-button pan until pointer-up even if Space is released', () => {
    const { viewport, content, state } = renderHarness()
    fireEvent.pointerEnter(viewport)
    fireEvent.keyDown(window, { code: 'Space' })
    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 0, pointerId: 7, clientX: 40, clientY: 50,
    }))
    expect(state).toHaveTextContent('space:panning')
    expect(viewport).toHaveStyle({ cursor: 'grabbing' })

    fireEvent.keyUp(window, { code: 'Space' })
    expect(state).toHaveTextContent('idle:panning')
    expect(viewport).toHaveStyle({ cursor: 'grabbing' })
    fireEvent(viewport, pointerEvent('pointermove', {
      pointerId: 7, clientX: 70, clientY: 65,
    }))
    expect(content.style.transform).toBe('translate(30px, 15px) scale(1)')

    fireEvent(viewport, pointerEvent('pointerup', { button: 0, pointerId: 7 }))
    expect(state).toHaveTextContent('idle:still')
    expect(viewport).toHaveStyle({ cursor: 'crosshair' })
  })

  it('resets an active gesture on blur and visibility loss', () => {
    const { viewport, state } = renderHarness()
    fireEvent.pointerEnter(viewport)
    fireEvent.keyDown(window, { code: 'Space' })
    fireEvent(viewport, pointerEvent('pointerdown', { button: 0, pointerId: 1 }))
    fireEvent(window, new Event('blur'))
    expect(state).toHaveTextContent('idle:still')

    fireEvent.keyDown(window, { code: 'Space' })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    fireEvent(document, new Event('visibilitychange'))
    expect(state).toHaveTextContent('idle:still')
  })
})
