import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InpaintCanvas, {
  resolveBrushAdjustment,
  resolveBrushAdjustmentAxis,
  type BrushAdjustment,
  type InpaintMode,
} from './InpaintCanvas'

const nativeImage = globalThis.Image

function pointerEvent(
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: MouseEventInit & { pointerId?: number; pointerType?: string } = {},
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    pointerType: { value: init.pointerType ?? 'mouse' },
  })
  return event
}

function Harness({
  mode = 'paint',
  erase = false,
  onBrushAdjust,
  onStrokeEnd,
  onMaskStrokeEnd,
  onPickColor = vi.fn(),
}: {
  mode?: InpaintMode
  erase?: boolean
  onBrushAdjust: (next: BrushAdjustment) => void
  onStrokeEnd: ReturnType<typeof vi.fn>
  onMaskStrokeEnd: ReturnType<typeof vi.fn>
  onPickColor?: ReturnType<typeof vi.fn>
}) {
  const [brush, setBrush] = useState({ color: '#ffffff', size: 20, hardness: 0.5 })
  return (
    <div style={{ width: 500, height: 400 }}>
      <InpaintCanvas
        imageUrl="/image.png"
        imageW={400}
        imageH={400}
        mode={mode}
        strokes={[]}
        maskEdits={[]}
        maskBaseUrl={null}
        brush={brush}
        onBrushAdjust={(next) => {
          onBrushAdjust(next)
          setBrush((prev) => ({ ...prev, ...next }))
        }}
        erase={erase}
        onStrokeEnd={onStrokeEnd}
        onMaskStrokeEnd={onMaskStrokeEnd}
        onPickColor={onPickColor}
      />
    </div>
  )
}

describe('resolveBrushAdjustment', () => {
  it('waits for a clear dominant direction before locking an axis', () => {
    expect(resolveBrushAdjustmentAxis(5, 0)).toBe('pending')
    expect(resolveBrushAdjustmentAxis(10, 9)).toBe('pending')
    expect(resolveBrushAdjustmentAxis(13, 8)).toBe('size')
    expect(resolveBrushAdjustmentAxis(8, 13)).toBe('hardness')
  })

  it('changes only the locked axis and subtracts the startup dead zone', () => {
    expect(resolveBrushAdjustment({ size: 100, hardness: 0.5 }, 26, -20, 0.5, 'size')).toEqual({
      size: 140,
      hardness: 0.5,
    })
    expect(resolveBrushAdjustment({ size: 100, hardness: 0.5 }, -20, 26, 0.5, 'hardness')).toEqual({
      size: 100,
      hardness: 0.3,
    })
    expect(resolveBrushAdjustment({ size: 100, hardness: 0.5 }, 100, -100, 1, 'pending'))
      .toEqual({ size: 100, hardness: 0.5 })
  })

  it('clamps diameter and hardness to the existing control ranges', () => {
    expect(resolveBrushAdjustment({ size: 399, hardness: 0.99 }, 500, -500, 1, 'size')).toEqual({
      size: 400,
      hardness: 0.99,
    })
    expect(resolveBrushAdjustment({ size: 2, hardness: 0.01 }, -500, 500, 1, 'hardness')).toEqual({
      size: 2,
      hardness: 0,
    })
  })
})

describe('InpaintCanvas brush adjustment gesture', () => {
  const context = {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([10, 20, 30, 255]) })),
    putImageData: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(Element.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    })
    Object.defineProperty(globalThis, 'Image', {
      configurable: true,
      writable: true,
      value: class ImmediateImage {
        onload: ((event: Event) => void) | null = null
        onerror: ((event: Event) => void) | null = null
        naturalWidth = 400
        naturalHeight = 400

        set src(_value: string) {
          queueMicrotask(() => this.onload?.(new Event('load')))
        }
      },
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext() {
      return { ...context, canvas: this } as unknown as CanvasRenderingContext2D
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 400,
      width: 500, height: 400, toJSON: () => ({}),
    } as DOMRect)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(globalThis, 'Image', {
      configurable: true,
      writable: true,
      value: nativeImage,
    })
  })

  async function renderLoaded(options: { mode?: InpaintMode; erase?: boolean } = {}) {
    const callbacks = {
      onBrushAdjust: vi.fn(),
      onStrokeEnd: vi.fn(),
      onMaskStrokeEnd: vi.fn(),
    }
    const view = render(<Harness {...options} {...callbacks} />)
    await waitFor(() => expect(screen.queryByText('加载原图...')).not.toBeInTheDocument())
    const canvas = view.container.querySelector('canvas') as HTMLCanvasElement
    const viewport = canvas.parentElement as HTMLDivElement
    fireEvent.click(screen.getByRole('button', { name: '100%' }))
    return { ...callbacks, viewport }
  }

  it('locks horizontal movement to diameter despite vertical jitter', async () => {
    const { viewport, onBrushAdjust, onStrokeEnd, onMaskStrokeEnd } = await renderLoaded()

    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 2, buttons: 2, altKey: true, clientX: 200, clientY: 200,
    }))
    expect(screen.getByTestId('brush-adjust-hud')).toHaveTextContent('直径：20 像素')
    expect(screen.getByTestId('brush-adjust-hud')).toHaveTextContent('硬度：50%')

    fireEvent(viewport, pointerEvent('pointermove', {
      button: 2, buttons: 2, clientX: 230, clientY: 196,
    }))
    expect(onBrushAdjust).toHaveBeenLastCalledWith({ size: 44, hardness: 0.5 })
    expect(screen.getByTestId('brush-adjust-hud')).toHaveTextContent('直径：44 像素')
    expect(screen.getByTestId('brush-adjust-hud')).toHaveTextContent('硬度：50%')
    expect(screen.getByTestId('brush-adjust-hud').firstElementChild).toHaveClass(
      'font-semibold', 'text-accent',
    )
    expect(screen.getByTestId('brush-adjust-hud').lastElementChild).toHaveClass('text-fg-disabled')
    expect(screen.getByTestId('brush-cursor')).toHaveStyle({ width: '44px', height: '44px' })

    const callsBeforeTurn = onBrushAdjust.mock.calls.length
    fireEvent(viewport, pointerEvent('pointermove', {
      button: 2, buttons: 2, clientX: 230, clientY: 280,
    }))
    expect(onBrushAdjust).toHaveBeenCalledTimes(callsBeforeTurn)
    expect(screen.getByTestId('brush-adjust-hud')).toHaveTextContent('硬度：50%')

    fireEvent(viewport, pointerEvent('pointerup', {
      button: 2, clientX: 230, clientY: 280,
    }))
    expect(screen.queryByTestId('brush-adjust-hud')).not.toBeInTheDocument()
    expect(onStrokeEnd).not.toHaveBeenCalled()
    expect(onMaskStrokeEnd).not.toHaveBeenCalled()
  })

  it('starts a new gesture to lock vertical movement to hardness', async () => {
    const { viewport, onBrushAdjust } = await renderLoaded()

    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 2, buttons: 2, altKey: true, clientX: 200, clientY: 200,
    }))
    fireEvent(viewport, pointerEvent('pointermove', {
      button: 2, buttons: 2, clientX: 210, clientY: 199,
    }))
    expect(onBrushAdjust).toHaveBeenLastCalledWith({ size: 24, hardness: 0.5 })
    fireEvent(viewport, pointerEvent('pointerup', {
      button: 2, clientX: 210, clientY: 199,
    }))

    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 2, buttons: 2, altKey: true, clientX: 200, clientY: 200,
    }))
    fireEvent(viewport, pointerEvent('pointermove', {
      button: 2, buttons: 2, clientX: 203, clientY: 170,
    }))

    expect(onBrushAdjust).toHaveBeenLastCalledWith({ size: 24, hardness: 0.74 })
    expect(screen.getByTestId('brush-adjust-hud')).toHaveTextContent('直径：24 像素')
    expect(screen.getByTestId('brush-adjust-hud')).toHaveTextContent('硬度：74%')
    expect(screen.getByTestId('brush-adjust-hud').firstElementChild).toHaveClass('text-fg-disabled')
    expect(screen.getByTestId('brush-adjust-hud').lastElementChild).toHaveClass(
      'font-semibold', 'text-accent',
    )
  })

  it('keeps ambiguous and sub-threshold movement pending without writes', async () => {
    const { viewport, onBrushAdjust } = await renderLoaded()
    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 2, buttons: 2, altKey: true, clientX: 200, clientY: 200,
    }))
    fireEvent(viewport, pointerEvent('pointermove', {
      button: 2, buttons: 2, clientX: 205, clientY: 203,
    }))
    fireEvent(viewport, pointerEvent('pointermove', {
      button: 2, buttons: 2, clientX: 220, clientY: 218,
    }))

    expect(onBrushAdjust).not.toHaveBeenCalled()
    expect(screen.getByTestId('brush-adjust-hud')).toHaveTextContent('直径：20 像素')
    expect(screen.getByTestId('brush-adjust-hud')).toHaveTextContent('硬度：50%')

    fireEvent(viewport, pointerEvent('pointermove', {
      button: 2, buttons: 2, clientX: 230, clientY: 218,
    }))
    expect(onBrushAdjust).toHaveBeenLastCalledWith({ size: 44, hardness: 0.5 })
  })

  it('works for the training-mask eraser and suppresses only its context menu', async () => {
    const { viewport, onBrushAdjust, onStrokeEnd, onMaskStrokeEnd } = await renderLoaded({
      mode: 'mask', erase: true,
    })

    const ordinaryMenu = new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
    })
    fireEvent(viewport, ordinaryMenu)
    expect(ordinaryMenu.defaultPrevented).toBe(false)

    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 2, buttons: 2, altKey: true, clientX: 100, clientY: 100,
    }))
    fireEvent(viewport, pointerEvent('pointermove', {
      button: 2, buttons: 2, clientX: 110, clientY: 99,
    }))
    fireEvent(viewport, pointerEvent('pointerup', {
      button: 2, clientX: 110, clientY: 99,
    }))
    const adjustedMenu = new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
    })
    fireEvent(viewport, adjustedMenu)

    expect(adjustedMenu.defaultPrevented).toBe(true)
    expect(onBrushAdjust).toHaveBeenCalled()
    expect(onStrokeEnd).not.toHaveBeenCalled()
    expect(onMaskStrokeEnd).not.toHaveBeenCalled()
  })

  it('ignores Alt-right gestures from non-mouse pointers', async () => {
    const { viewport, onBrushAdjust } = await renderLoaded()

    fireEvent(viewport, pointerEvent('pointerdown', {
      pointerType: 'pen', button: 2, buttons: 2, altKey: true, clientX: 100, clientY: 100,
    }))
    fireEvent(viewport, pointerEvent('pointermove', {
      pointerType: 'pen', button: 2, buttons: 2, clientX: 140, clientY: 80,
    }))

    expect(screen.queryByTestId('brush-adjust-hud')).not.toBeInTheDocument()
    expect(onBrushAdjust).not.toHaveBeenCalled()
  })

  it('cleans up the HUD when the pointer is cancelled', async () => {
    const { viewport } = await renderLoaded()
    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 2, buttons: 2, altKey: true, clientX: 100, clientY: 100,
    }))
    expect(screen.getByTestId('brush-adjust-hud')).toBeInTheDocument()

    await act(async () => {
      fireEvent(viewport, pointerEvent('pointercancel', { button: 2 }))
    })
    expect(screen.queryByTestId('brush-adjust-hud')).not.toBeInTheDocument()
  })
})
