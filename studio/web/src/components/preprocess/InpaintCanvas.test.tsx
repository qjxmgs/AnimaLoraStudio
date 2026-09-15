import { createRef, useState, type Ref } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InpaintCanvas, {
  resolveBrushAdjustment,
  resolveBrushAdjustmentAxis,
  resolveStraightStrokeGuide,
  type BrushAdjustment,
  type InpaintCanvasHandle,
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
  imageUrl = '/image.png',
  mode = 'paint',
  tool = 'brush',
  onBrushAdjust,
  onStrokeEnd,
  onMaskStrokeEnd,
  onLassoCreate,
  onLassoUpdate,
  onLassoDelete,
  onPickColor = vi.fn(),
  inpaintRef,
}: {
  imageUrl?: string
  mode?: InpaintMode
  tool?: InpaintTool
  onBrushAdjust: (next: BrushAdjustment) => void
  onStrokeEnd: ReturnType<typeof vi.fn>
  onMaskStrokeEnd: ReturnType<typeof vi.fn>
  onLassoCreate: ReturnType<typeof vi.fn>
  onLassoUpdate: ReturnType<typeof vi.fn>
  onLassoDelete: ReturnType<typeof vi.fn>
  onPickColor?: ReturnType<typeof vi.fn>
  inpaintRef?: Ref<InpaintCanvasHandle>
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
  const deleteLasso = (target: InpaintMode, shapeId: string) => {
    onLassoDelete(target, shapeId)
    const remove = <T extends PaintEdit | MaskEdit>(edits: T[]): T[] => edits.filter((edit) => (
      edit.type !== 'lasso' || edit.shape.id !== shapeId
    ))
    if (target === 'paint') setPaintEdits((prev) => remove(prev))
    else setMaskEdits((prev) => remove(prev))
  }
  return (
    <div style={{ width: 500, height: 400 }}>
      <InpaintCanvas
        ref={inpaintRef}
        imageUrl={imageUrl}
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
        onLassoDelete={deleteLasso}
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

describe('resolveStraightStrokeGuide', () => {
  it('offsets horizontal and vertical guide sides by the brush radius', () => {
    expect(resolveStraightStrokeGuide(
      { x: 10, y: 20 }, { x: 110, y: 20 }, 20, 1,
    )).toEqual({
      radius: 10,
      sides: [
        { x1: 10, y1: 30, x2: 110, y2: 30 },
        { x1: 10, y1: 10, x2: 110, y2: 10 },
      ],
    })
    expect(resolveStraightStrokeGuide(
      { x: 10, y: 20 }, { x: 10, y: 120 }, 20, 1,
    )).toEqual({
      radius: 10,
      sides: [
        { x1: 0, y1: 20, x2: 0, y2: 120 },
        { x1: 20, y1: 20, x2: 20, y2: 120 },
      ],
    })
  })

  it('keeps diagonal guide width equal to the brush diameter', () => {
    const guide = resolveStraightStrokeGuide(
      { x: 10, y: 10 }, { x: 110, y: 110 }, 30, 1,
    )
    expect(guide).not.toBeNull()
    const [first, second] = guide!.sides
    expect(Math.hypot(first.x1 - second.x1, first.y1 - second.y1)).toBeCloseTo(30)
    expect(Math.hypot(first.x2 - second.x2, first.y2 - second.y2)).toBeCloseTo(30)
  })

  it('hides a channel shorter than one screen pixel', () => {
    expect(resolveStraightStrokeGuide(
      { x: 10, y: 10 }, { x: 10.5, y: 10 }, 20, 1,
    )).toBeNull()
    expect(resolveStraightStrokeGuide(
      { x: 10, y: 10 }, { x: 11, y: 10 }, 20, 1,
    )).not.toBeNull()
    expect(resolveStraightStrokeGuide(
      { x: 10, y: 10 }, { x: 11, y: 10 }, 20, 0.5,
    )).toBeNull()
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

  async function renderLoaded(options: {
    imageUrl?: string
    mode?: InpaintMode
    tool?: InpaintTool
    inpaintRef?: Ref<InpaintCanvasHandle>
  } = {}) {
    const callbacks = {
      onBrushAdjust: vi.fn(),
      onStrokeEnd: vi.fn(),
      onMaskStrokeEnd: vi.fn(),
      onLassoCreate: vi.fn(),
      onLassoUpdate: vi.fn(),
      onLassoDelete: vi.fn(),
      onPickColor: vi.fn(),
    }
    const view = render(<Harness {...options} {...callbacks} />)
    await waitFor(() => expect(screen.queryByText('加载原图...')).not.toBeInTheDocument())
    const viewport = screen.getByLabelText('涂抹编辑画布') as HTMLDivElement
    fireEvent.click(screen.getByRole('button', { name: '100%' }))
    return { ...callbacks, callbacks, viewport, rerender: view.rerender }
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

  it.each([
    { mode: 'paint' as const, tool: 'brush' as const, color: '#ffffff', erase: false },
    { mode: 'paint' as const, tool: 'eraser' as const, color: '#ffffff', erase: true },
    { mode: 'mask' as const, tool: 'brush' as const, color: '#ff2d2d', erase: false },
    { mode: 'mask' as const, tool: 'eraser' as const, color: '#ff2d2d', erase: true },
  ])('draws a fixed Shift-click line with current $mode/$tool settings', async ({
    mode, tool, color, erase,
  }) => {
    const { viewport, onStrokeEnd, onMaskStrokeEnd } = await renderLoaded({ mode, tool })
    const callback = mode === 'mask' ? onMaskStrokeEnd : onStrokeEnd

    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 0, buttons: 1, clientX: 100, clientY: 100,
    }))
    fireEvent(viewport, pointerEvent('pointermove', {
      button: 0, buttons: 1, clientX: 130, clientY: 120,
    }))
    fireEvent(viewport, pointerEvent('pointerup', {
      button: 0, clientX: 130, clientY: 120,
    }))

    previewStroke.mockClear()
    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 0, buttons: 1, clientX: 200, clientY: 150, shiftKey: true,
    }))
    expect(previewStroke).toHaveBeenCalled()
    fireEvent(viewport, pointerEvent('pointermove', {
      button: 0, buttons: 1, clientX: 280, clientY: 260, shiftKey: true,
    }))
    fireEvent(viewport, pointerEvent('pointerup', {
      button: 0, clientX: 280, clientY: 260, shiftKey: true,
    }))

    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback).toHaveBeenLastCalledWith({
      color,
      size: 20,
      hardness: 0.5,
      ...(erase ? { erase: true } : {}),
      points: [{ x: 80, y: 120 }, { x: 150, y: 150 }],
    })
  })

  it('chains Shift-click lines and treats the first Shift-click as a fixed dot', async () => {
    const { viewport, onStrokeEnd } = await renderLoaded()
    const shiftTap = (downX: number, downY: number, moveX: number, moveY: number) => {
      fireEvent(viewport, pointerEvent('pointerdown', {
        button: 0, buttons: 1, clientX: downX, clientY: downY, shiftKey: true,
      }))
      fireEvent(viewport, pointerEvent('pointermove', {
        button: 0, buttons: 1, clientX: moveX, clientY: moveY, shiftKey: true,
      }))
      fireEvent(viewport, pointerEvent('pointerup', {
        button: 0, clientX: moveX, clientY: moveY, shiftKey: true,
      }))
    }

    shiftTap(100, 100, 150, 140)
    shiftTap(200, 150, 240, 190)
    shiftTap(250, 200, 280, 240)

    expect(onStrokeEnd).toHaveBeenNthCalledWith(1, expect.objectContaining({
      points: [{ x: 50, y: 100 }],
    }))
    expect(onStrokeEnd).toHaveBeenNthCalledWith(2, expect.objectContaining({
      points: [{ x: 50, y: 100 }, { x: 150, y: 150 }],
    }))
    expect(onStrokeEnd).toHaveBeenNthCalledWith(3, expect.objectContaining({
      points: [{ x: 150, y: 150 }, { x: 200, y: 200 }],
    }))
  })

  it('cancels a Shift-click line without replacing the previous endpoint', async () => {
    const { viewport, onStrokeEnd } = await renderLoaded()
    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 0, buttons: 1, clientX: 100, clientY: 100,
    }))
    fireEvent(viewport, pointerEvent('pointerup', { button: 0, clientX: 100, clientY: 100 }))

    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 0, buttons: 1, clientX: 180, clientY: 160, shiftKey: true,
    }))
    fireEvent(viewport, pointerEvent('pointercancel', {
      button: 0, clientX: 180, clientY: 160, shiftKey: true,
    }))
    expect(onStrokeEnd).toHaveBeenCalledTimes(1)

    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 0, buttons: 1, clientX: 220, clientY: 180, shiftKey: true,
    }))
    fireEvent(viewport, pointerEvent('pointerup', {
      button: 0, clientX: 220, clientY: 180, shiftKey: true,
    }))
    expect(onStrokeEnd).toHaveBeenLastCalledWith(expect.objectContaining({
      points: [{ x: 50, y: 100 }, { x: 170, y: 180 }],
    }))
  })

  it('clears the Shift-click endpoint through the canvas handle', async () => {
    const inpaintRef = createRef<InpaintCanvasHandle>()
    const { viewport, onStrokeEnd } = await renderLoaded({ inpaintRef })
    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 0, buttons: 1, clientX: 100, clientY: 100,
    }))
    fireEvent(viewport, pointerEvent('pointerup', { button: 0, clientX: 100, clientY: 100 }))

    act(() => inpaintRef.current?.resetStrokeAnchor())
    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 0, buttons: 1, clientX: 200, clientY: 150, shiftKey: true,
    }))
    fireEvent(viewport, pointerEvent('pointerup', {
      button: 0, clientX: 200, clientY: 150, shiftKey: true,
    }))
    expect(onStrokeEnd).toHaveBeenLastCalledWith(expect.objectContaining({
      points: [{ x: 150, y: 150 }],
    }))
  })

  it('clears the Shift-click endpoint when the tool, mode, or image changes', async () => {
    const result = await renderLoaded()
    const tap = (viewport: HTMLElement, x: number, y: number, shiftKey = false) => {
      fireEvent(viewport, pointerEvent('pointerdown', {
        button: 0, buttons: 1, clientX: x, clientY: y, shiftKey,
      }))
      fireEvent(viewport, pointerEvent('pointerup', {
        button: 0, clientX: x, clientY: y, shiftKey,
      }))
    }
    tap(result.viewport, 100, 100)

    result.rerender(<Harness {...result.callbacks} tool="eraser" />)
    tap(result.viewport, 180, 140, true)
    expect(result.onStrokeEnd).toHaveBeenLastCalledWith(expect.objectContaining({
      erase: true,
      points: [{ x: 130, y: 140 }],
    }))

    tap(result.viewport, 190, 150)
    result.rerender(<Harness {...result.callbacks} mode="mask" tool="eraser" />)
    tap(result.viewport, 200, 160, true)
    expect(result.onMaskStrokeEnd).toHaveBeenLastCalledWith(expect.objectContaining({
      erase: true,
      points: [{ x: 150, y: 160 }],
    }))

    tap(result.viewport, 210, 170)
    result.rerender(
      <Harness {...result.callbacks} imageUrl="/other.png" mode="mask" tool="eraser" />,
    )
    await waitFor(() => expect(screen.queryByText('加载原图...')).not.toBeInTheDocument())
    tap(result.viewport, 220, 180, true)
    expect(result.onMaskStrokeEnd).toHaveBeenLastCalledWith(expect.objectContaining({
      erase: true,
      points: [expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
      })],
    }))
  })

  it('keeps Alt color picking ahead of Shift-click drawing', async () => {
    const { viewport, onPickColor, onStrokeEnd } = await renderLoaded()
    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 0, buttons: 1, clientX: 100, clientY: 100, altKey: true, shiftKey: true,
    }))
    fireEvent(viewport, pointerEvent('pointerup', {
      button: 0, clientX: 100, clientY: 100, altKey: true, shiftKey: true,
    }))
    expect(onPickColor).toHaveBeenCalledWith('#0a141e')
    expect(onStrokeEnd).not.toHaveBeenCalled()
  })

  it('shows a live double-sided Shift guide and start circle before clicking', async () => {
    const { viewport } = await renderLoaded()
    fireEvent(viewport, pointerEvent('pointermove', { clientX: 100, clientY: 100 }))
    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 0, buttons: 1, clientX: 100, clientY: 100,
    }))
    fireEvent(viewport, pointerEvent('pointerup', { button: 0, clientX: 100, clientY: 100 }))
    fireEvent(viewport, pointerEvent('pointermove', { clientX: 200, clientY: 100 }))

    fireEvent.keyDown(window, { code: 'ShiftLeft', key: 'Shift', shiftKey: true })
    const guide = screen.getByTestId('straight-stroke-guide')
    const start = screen.getByTestId('straight-stroke-guide-start')
    const sides = guide.querySelectorAll('[data-guide-side]')
    expect(start).toHaveAttribute('cx', '50')
    expect(start).toHaveAttribute('cy', '100')
    expect(start).toHaveAttribute('r', '10')
    expect(sides).toHaveLength(2)
    expect(sides[0]).toHaveAttribute('x1', '50')
    expect(sides[0]).toHaveAttribute('x2', '150')
    expect([sides[0].getAttribute('y1'), sides[1].getAttribute('y1')].sort())
      .toEqual(['110', '90'])
    expect(sides[0]).toHaveAttribute('stroke', '#ffffff')
    expect(guide.querySelector('g')).toHaveAttribute('stroke-dasharray', '6 4')

    fireEvent(viewport, pointerEvent('pointermove', { clientX: 220, clientY: 120 }))
    const movedSide = screen.getByTestId('straight-stroke-guide')
      .querySelector('[data-guide-side="0"]')
    expect(Number(movedSide?.getAttribute('x2'))).toBeGreaterThan(160)

    fireEvent.keyUp(window, { code: 'ShiftLeft', key: 'Shift' })
    expect(screen.queryByTestId('straight-stroke-guide')).not.toBeInTheDocument()
  })

  it('freezes the Shift guide and brush circle at pointer-down until release', async () => {
    const { viewport, onStrokeEnd } = await renderLoaded()
    fireEvent(viewport, pointerEvent('pointermove', { clientX: 100, clientY: 100 }))
    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 0, buttons: 1, clientX: 100, clientY: 100,
    }))
    fireEvent(viewport, pointerEvent('pointerup', { button: 0, clientX: 100, clientY: 100 }))
    fireEvent(viewport, pointerEvent('pointermove', { clientX: 200, clientY: 100 }))
    fireEvent.keyDown(window, { code: 'ShiftLeft', key: 'Shift', shiftKey: true })

    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 0, buttons: 1, clientX: 200, clientY: 100, shiftKey: true,
    }))
    fireEvent(viewport, pointerEvent('pointermove', {
      button: 0, buttons: 1, clientX: 280, clientY: 100, shiftKey: true,
    }))
    expect(screen.getByTestId('straight-stroke-guide').querySelector('[data-guide-side="0"]'))
      .toHaveAttribute('x2', '150')
    expect(screen.getByTestId('brush-cursor')).toHaveStyle({ left: '190px' })

    fireEvent(viewport, pointerEvent('pointerup', {
      button: 0, clientX: 280, clientY: 100, shiftKey: true,
    }))
    expect(onStrokeEnd).toHaveBeenLastCalledWith(expect.objectContaining({
      points: [{ x: 50, y: 100 }, { x: 150, y: 100 }],
    }))
    expect(screen.getByTestId('straight-stroke-guide').querySelector('[data-guide-side="0"]'))
      .toHaveAttribute('x2', '230')
    expect(screen.getByTestId('brush-cursor')).toHaveStyle({ left: '270px' })
  })

  it.each([
    { mode: 'paint' as const, tool: 'eraser' as const, color: '#ffffff' },
    { mode: 'mask' as const, tool: 'brush' as const, color: '#ff2d2d' },
    { mode: 'mask' as const, tool: 'eraser' as const, color: '#ffffff' },
  ])('uses the expected $mode/$tool guide color', async ({ mode, tool, color }) => {
    const { viewport } = await renderLoaded({ mode, tool })
    fireEvent(viewport, pointerEvent('pointermove', { clientX: 100, clientY: 100 }))
    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 0, buttons: 1, clientX: 100, clientY: 100,
    }))
    fireEvent(viewport, pointerEvent('pointerup', { button: 0, clientX: 100, clientY: 100 }))
    fireEvent(viewport, pointerEvent('pointermove', { clientX: 200, clientY: 100 }))
    fireEvent.keyDown(window, { code: 'ShiftLeft', key: 'Shift', shiftKey: true })
    expect(screen.getByTestId('straight-stroke-guide').querySelector('[data-guide-side="0"]'))
      .toHaveAttribute('stroke', color)
  })

  it('hides the Shift guide for conflicting modifiers and window blur', async () => {
    const { viewport } = await renderLoaded()
    fireEvent(viewport, pointerEvent('pointermove', { clientX: 100, clientY: 100 }))
    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 0, buttons: 1, clientX: 100, clientY: 100,
    }))
    fireEvent(viewport, pointerEvent('pointerup', { button: 0, clientX: 100, clientY: 100 }))
    fireEvent(viewport, pointerEvent('pointermove', { clientX: 200, clientY: 100 }))
    fireEvent.keyDown(window, { code: 'ShiftLeft', key: 'Shift', shiftKey: true })
    expect(screen.getByTestId('straight-stroke-guide')).toBeInTheDocument()

    fireEvent.keyDown(window, {
      code: 'AltLeft', key: 'Alt', shiftKey: true, altKey: true,
    })
    expect(screen.queryByTestId('straight-stroke-guide')).not.toBeInTheDocument()
    fireEvent.keyUp(window, { code: 'AltLeft', key: 'Alt', shiftKey: true })
    expect(screen.getByTestId('straight-stroke-guide')).toBeInTheDocument()

    fireEvent(window, new Event('blur'))
    expect(screen.queryByTestId('straight-stroke-guide')).not.toBeInTheDocument()
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

  it('deletes the selected closed lasso with Delete and ignores modified keys', async () => {
    const { viewport, onLassoCreate, onLassoDelete, onLassoUpdate } = await renderLoaded({
      mode: 'mask', tool: 'lasso',
    })
    const tap = (x: number, y: number) => {
      fireEvent(viewport, pointerEvent('pointerdown', { button: 0, clientX: x, clientY: y }))
      fireEvent(viewport, pointerEvent('pointerup', { button: 0, clientX: x, clientY: y }))
    }
    tap(100, 100); tap(200, 100); tap(200, 200); tap(100, 100)
    const shape = onLassoCreate.mock.calls[0][1] as LassoShape
    expect(screen.getByTestId('lasso-overlay').querySelectorAll('[data-lasso-point-id]'))
      .toHaveLength(3)

    fireEvent.keyDown(window, { code: 'Backspace', key: 'Backspace' })
    fireEvent.keyDown(window, { code: 'Delete', key: 'Delete', ctrlKey: true })
    fireEvent.keyDown(window, { code: 'Delete', key: 'Delete', repeat: true })
    expect(onLassoDelete).not.toHaveBeenCalled()

    expect(fireEvent.keyDown(window, { code: 'Delete', key: 'Delete' })).toBe(false)
    expect(onLassoDelete).toHaveBeenCalledTimes(1)
    expect(onLassoDelete).toHaveBeenCalledWith('mask', shape.id)
    expect(screen.getByTestId('lasso-overlay').querySelectorAll('[data-lasso-point-id]'))
      .toHaveLength(0)

    fireEvent.keyDown(window, { code: 'KeyC', key: 'c' })
    expect(onLassoUpdate).not.toHaveBeenCalled()
  })

  it('does not delete an open lasso draft without a selected closed shape', async () => {
    const { viewport, onLassoDelete } = await renderLoaded({ tool: 'lasso' })
    fireEvent(viewport, pointerEvent('pointerdown', {
      button: 0, clientX: 100, clientY: 100,
    }))
    fireEvent(viewport, pointerEvent('pointerup', {
      button: 0, clientX: 100, clientY: 100,
    }))
    expect(screen.getByTestId('lasso-draft')).toBeInTheDocument()

    expect(fireEvent.keyDown(window, { code: 'Delete', key: 'Delete' })).toBe(true)
    expect(onLassoDelete).not.toHaveBeenCalled()
    expect(screen.getByTestId('lasso-draft')).toBeInTheDocument()
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
      onLassoCreate, onLassoUpdate, onLassoDelete,
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
      onLassoDelete={onLassoDelete}
    />)
    expect(screen.queryByTestId('brush-cursor')).not.toBeInTheDocument()

    rerender(<Harness
      tool="brush"
      onBrushAdjust={onBrushAdjust}
      onStrokeEnd={onStrokeEnd}
      onMaskStrokeEnd={onMaskStrokeEnd}
      onLassoCreate={onLassoCreate}
      onLassoUpdate={onLassoUpdate}
      onLassoDelete={onLassoDelete}
    />)
    expect(screen.getByTestId('brush-cursor')).toHaveStyle({ display: 'none' })
    fireEvent(viewport, pointerEvent('pointermove', { clientX: 190, clientY: 170 }))
    expect(screen.getByTestId('brush-cursor')).toHaveStyle({ display: 'block' })
  })
})
