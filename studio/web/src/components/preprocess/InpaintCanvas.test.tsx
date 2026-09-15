import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InpaintCanvas, {
  resolveBrushAdjustment,
  resolveBrushAdjustmentAxis,
  type BrushAdjustment,
  type InpaintMode,
  type InpaintTool,
  type LassoShape,
  type MaskEdit,
  type PaintEdit,
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
  tool = 'brush',
  onBrushAdjust,
  onStrokeEnd,
  onMaskStrokeEnd,
  onLassoCreate,
  onLassoUpdate,
  onPickColor = vi.fn(),
}: {
  mode?: InpaintMode
  tool?: InpaintTool
  onBrushAdjust: (next: BrushAdjustment) => void
  onStrokeEnd: ReturnType<typeof vi.fn>
  onMaskStrokeEnd: ReturnType<typeof vi.fn>
  onLassoCreate: ReturnType<typeof vi.fn>
  onLassoUpdate: ReturnType<typeof vi.fn>
  onPickColor?: ReturnType<typeof vi.fn>
}) {
  const [brush, setBrush] = useState({ color: '#ffffff', size: 20, hardness: 0.5 })
  const [paintEdits, setPaintEdits] = useState<PaintEdit[]>([])
  const [maskEdits, setMaskEdits] = useState<MaskEdit[]>([])
  const createLasso = (target: InpaintMode, shape: LassoShape) => {
    onLassoCreate(target, shape)
    if (target === 'paint') setPaintEdits((prev) => [...prev, { type: 'lasso', shape }])
    else setMaskEdits((prev) => [...prev, { type: 'lasso', shape }])
  }
  const updateLasso = (target: InpaintMode, shape: LassoShape) => {
    onLassoUpdate(target, shape)
    const replace = <T extends PaintEdit | MaskEdit>(edits: T[]): T[] => edits.map((edit) => (
      edit.type === 'lasso' && edit.shape.id === shape.id ? { ...edit, shape } : edit
    )) as T[]
    if (target === 'paint') setPaintEdits((prev) => replace(prev))
    else setMaskEdits((prev) => replace(prev))
  }
  return (
    <div style={{ width: 500, height: 400 }}>
      <InpaintCanvas
        imageUrl="/image.png"
        imageW={400}
        imageH={400}
        mode={mode}
        paintEdits={paintEdits}
        maskEdits={maskEdits}
        maskBaseUrl={null}
        brush={brush}
        onBrushAdjust={(next) => {
          onBrushAdjust(next)
          setBrush((prev) => ({ ...prev, ...next }))
        }}
        tool={tool}
        onStrokeEnd={onStrokeEnd}
        onMaskStrokeEnd={onMaskStrokeEnd}
        onLassoCreate={createLasso}
        onLassoUpdate={updateLasso}
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
  const previewClearRect = vi.fn()
  const previewStroke = vi.fn()
  const context = {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([10, 20, 30, 255]) })),
    putImageData: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    bezierCurveTo: vi.fn(),
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
      return {
        ...context,
        ...(this.dataset.testid === 'stroke-preview-canvas'
          ? { clearRect: previewClearRect, stroke: previewStroke }
          : {}),
        canvas: this,
      } as unknown as CanvasRenderingContext2D
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

  async function renderLoaded(options: { mode?: InpaintMode; tool?: InpaintTool } = {}) {
    const callbacks = {
      onBrushAdjust: vi.fn(),
      onStrokeEnd: vi.fn(),
      onMaskStrokeEnd: vi.fn(),
      onLassoCreate: vi.fn(),
      onLassoUpdate: vi.fn(),
    }
    const view = render(<Harness {...options} {...callbacks} />)
    await waitFor(() => expect(screen.queryByText('加载原图...')).not.toBeInTheDocument())
    const viewport = screen.getByLabelText('涂抹编辑画布') as HTMLDivElement
    fireEvent.click(screen.getByRole('button', { name: '100%' }))
    return { ...callbacks, viewport, rerender: view.rerender }
  }

  it.each<InpaintTool>(['brush', 'eraser', 'lasso'])(
    'uses Space-left-drag to pan in %s mode without editing',
    async (tool) => {
      const {
        viewport, onStrokeEnd, onMaskStrokeEnd, onLassoCreate, onLassoUpdate,
      } = await renderLoaded({ mode: 'mask', tool })
      if (tool !== 'lasso') {
        fireEvent(viewport, pointerEvent('pointermove', { clientX: 160, clientY: 150 }))
        expect(screen.getByTestId('brush-cursor')).toHaveStyle({ display: 'block' })
      }

      fireEvent.pointerEnter(viewport)
      fireEvent.keyDown(window, { code: 'Space' })
      expect(viewport).toHaveStyle({ cursor: 'grab' })
      if (tool !== 'lasso') {
        expect(screen.getByTestId('brush-cursor')).toHaveStyle({ opacity: '0' })
      }

      fireEvent(viewport, pointerEvent('pointerdown', {
        button: 0, buttons: 1, pointerId: 8, clientX: 180, clientY: 170,
      }))
      expect(viewport).toHaveStyle({ cursor: 'grabbing' })
      fireEvent.keyUp(window, { code: 'Space' })
      expect(viewport).toHaveStyle({ cursor: 'grabbing' })
      fireEvent(viewport, pointerEvent('pointermove', {
        button: 0, buttons: 1, pointerId: 8, clientX: 220, clientY: 195,
      }))
      fireEvent(viewport, pointerEvent('pointerup', {
        button: 0, pointerId: 8, clientX: 220, clientY: 195,
      }))

      expect(onStrokeEnd).not.toHaveBeenCalled()
      expect(onMaskStrokeEnd).not.toHaveBeenCalled()
      expect(onLassoCreate).not.toHaveBeenCalled()
      expect(onLassoUpdate).not.toHaveBeenCalled()
      expect(viewport).toHaveStyle({ cursor: tool === 'lasso' ? 'crosshair' : 'none' })
      if (tool !== 'lasso') {
        expect(screen.getByTestId('brush-cursor')).toHaveStyle({ opacity: '1' })
      }
    },
  )

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
      mode: 'mask', tool: 'eraser',
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

  it('keeps an in-progress mask stroke on a uniformly composited preview layer', async () => {
    const { viewport, onStrokeEnd, onMaskStrokeEnd } = await renderLoaded({ mode: 'mask' })
    const preview = screen.getByTestId('stroke-preview-canvas')
    previewClearRect.mockClear()
    previewStroke.mockClear()

    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 0, buttons: 1, clientX: 120, clientY: 120,
    }))
    const clearsAfterDown = previewClearRect.mock.calls.length
    expect(clearsAfterDown).toBeGreaterThan(0)
    expect(preview).toHaveStyle({ filter: 'blur(5px)', opacity: '0.45' })

    fireEvent(viewport, pointerEvent('pointermove', {
      button: 0, buttons: 1, clientX: 150, clientY: 140,
    }))
    expect(previewClearRect.mock.calls.length).toBe(clearsAfterDown)
    expect(previewStroke).toHaveBeenCalled()
    expect(onStrokeEnd).not.toHaveBeenCalled()
    expect(onMaskStrokeEnd).not.toHaveBeenCalled()

    fireEvent(viewport, pointerEvent('pointerup', {
      button: 0, clientX: 150, clientY: 140,
    }))
    expect(onMaskStrokeEnd).toHaveBeenCalledTimes(1)
  })

  it('builds and closes a lasso only after three points reach the start', async () => {
    const { viewport, onLassoCreate } = await renderLoaded({ tool: 'lasso' })
    const tap = (x: number, y: number) => {
      fireEvent(viewport, pointerEvent('pointerdown', { button: 0, clientX: x, clientY: y }))
      fireEvent(viewport, pointerEvent('pointerup', { button: 0, clientX: x, clientY: y }))
    }

    tap(100, 100)
    tap(200, 100)
    tap(200, 200)
    expect(onLassoCreate).not.toHaveBeenCalled()
    expect(screen.getByTestId('lasso-draft').querySelectorAll('circle')).toHaveLength(3)

    tap(108, 100)
    expect(onLassoCreate).toHaveBeenCalledTimes(1)
    expect(onLassoCreate).toHaveBeenCalledWith('paint', expect.objectContaining({
      color: '#ffffff',
      points: expect.arrayContaining([
        expect.objectContaining({ x: 50, y: 100, smooth: false }),
      ]),
    }))
    expect(screen.queryByTestId('lasso-draft')).not.toBeInTheDocument()
    expect(screen.getByTestId('lasso-overlay').querySelectorAll('[data-lasso-point-id]')).toHaveLength(3)
    expect(context.fill).toHaveBeenCalledWith('evenodd')
  })

  it('commits a dragged lasso point once and cancels a later drag safely', async () => {
    const { viewport, onLassoUpdate } = await renderLoaded({ tool: 'lasso' })
    const tap = (x: number, y: number) => {
      fireEvent(viewport, pointerEvent('pointerdown', { button: 0, clientX: x, clientY: y }))
      fireEvent(viewport, pointerEvent('pointerup', { button: 0, clientX: x, clientY: y }))
    }
    tap(100, 100); tap(200, 100); tap(200, 200); tap(100, 100)

    fireEvent(viewport, pointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100 }))
    fireEvent(viewport, pointerEvent('pointermove', { buttons: 1, clientX: 130, clientY: 120 }))
    expect(onLassoUpdate).not.toHaveBeenCalled()
    fireEvent(viewport, pointerEvent('pointerup', { button: 0, clientX: 130, clientY: 120 }))
    expect(onLassoUpdate).toHaveBeenCalledTimes(1)
    expect(onLassoUpdate).toHaveBeenLastCalledWith('paint', expect.objectContaining({
      points: expect.arrayContaining([expect.objectContaining({ x: 80, y: 120 })]),
    }))

    fireEvent(viewport, pointerEvent('pointerdown', { button: 0, clientX: 130, clientY: 120 }))
    fireEvent(viewport, pointerEvent('pointermove', { buttons: 1, clientX: 160, clientY: 140 }))
    fireEvent(viewport, pointerEvent('pointercancel', { button: 0, clientX: 160, clientY: 140 }))
    expect(onLassoUpdate).toHaveBeenCalledTimes(1)
  })

  it('toggles the selected anchor curve with C and ignores modified shortcuts', async () => {
    const { viewport, onLassoUpdate } = await renderLoaded({ mode: 'mask', tool: 'lasso' })
    const tap = (x: number, y: number) => {
      fireEvent(viewport, pointerEvent('pointerdown', { button: 0, clientX: x, clientY: y }))
      fireEvent(viewport, pointerEvent('pointerup', { button: 0, clientX: x, clientY: y }))
    }
    tap(100, 100); tap(200, 100); tap(200, 200); tap(100, 100)

    fireEvent.keyDown(window, { code: 'KeyC', key: 'c', ctrlKey: true })
    expect(onLassoUpdate).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { code: 'KeyC', key: 'c' })
    expect(onLassoUpdate).toHaveBeenCalledTimes(1)
    expect(onLassoUpdate).toHaveBeenLastCalledWith('mask', expect.objectContaining({
      points: expect.arrayContaining([expect.objectContaining({ smooth: true })]),
    }))
    fireEvent.keyDown(window, { code: 'KeyC', key: 'c' })
    expect(onLassoUpdate).toHaveBeenCalledTimes(2)
    expect(onLassoUpdate).toHaveBeenLastCalledWith('mask', expect.objectContaining({
      points: expect.arrayContaining([expect.objectContaining({ smooth: false })]),
    }))
  })

  it('cancels an open lasso with Escape and disables Alt-right brush adjustment', async () => {
    const { viewport, onBrushAdjust, onLassoCreate } = await renderLoaded({ tool: 'lasso' })
    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 0, clientX: 100, clientY: 100,
    }))
    expect(screen.getByTestId('lasso-draft')).toBeInTheDocument()
    fireEvent.keyDown(window, { code: 'Escape', key: 'Escape' })
    expect(screen.queryByTestId('lasso-draft')).not.toBeInTheDocument()

    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 2, buttons: 2, altKey: true, clientX: 100, clientY: 100,
    }))
    fireEvent(viewport, pointerEvent('pointermove', {
      button: 2, buttons: 2, clientX: 140, clientY: 80,
    }))
    expect(screen.queryByTestId('brush-adjust-hud')).not.toBeInTheDocument()
    expect(onBrushAdjust).not.toHaveBeenCalled()
    expect(onLassoCreate).not.toHaveBeenCalled()
  })

  it('removes the circular cursor in lasso mode and keeps it hidden until pointer movement', async () => {
    const {
      viewport, rerender, onBrushAdjust, onStrokeEnd, onMaskStrokeEnd,
      onLassoCreate, onLassoUpdate,
    } = await renderLoaded()

    fireEvent(viewport, pointerEvent('pointermove', { clientX: 180, clientY: 160 }))
    expect(screen.getByTestId('brush-cursor')).toHaveStyle({ display: 'block' })

    rerender(<Harness
      tool="lasso"
      onBrushAdjust={onBrushAdjust}
      onStrokeEnd={onStrokeEnd}
      onMaskStrokeEnd={onMaskStrokeEnd}
      onLassoCreate={onLassoCreate}
      onLassoUpdate={onLassoUpdate}
    />)
    expect(screen.queryByTestId('brush-cursor')).not.toBeInTheDocument()

    rerender(<Harness
      tool="brush"
      onBrushAdjust={onBrushAdjust}
      onStrokeEnd={onStrokeEnd}
      onMaskStrokeEnd={onMaskStrokeEnd}
      onLassoCreate={onLassoCreate}
      onLassoUpdate={onLassoUpdate}
    />)
    expect(screen.getByTestId('brush-cursor')).toHaveStyle({ display: 'none' })
    fireEvent(viewport, pointerEvent('pointermove', { clientX: 190, clientY: 170 }))
    expect(screen.getByTestId('brush-cursor')).toHaveStyle({ display: 'block' })
  })
})
