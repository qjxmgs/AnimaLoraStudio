import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useZoomPan } from '../../lib/useZoomPan'
import {
  loadTrainingMaskPreview,
  TRAINING_MASK_COLOR,
  TRAINING_MASK_VIEW_ALPHA,
} from './trainingMaskPreview'
import { mergeProposalBitmap } from './proposalMaskPreview'
import { hasBlockingVisibleModal } from './inpaintPreferences'

/** 一笔涂抹 / mask 笔画。坐标 / 直径都是**原图像素**单位 —— 视图缩放只影响
 *  显示，笔画数据与 zoom 无关，离屏重放（保存全部）才能与画布所见一致。 */
export interface InpaintStroke {
  color: string
  /** 笔刷直径（原图 px）。 */
  size: number
  /** 1 = 实心；<1 时边缘按 size*(1-hardness)/2 的半径 blur 软化。 */
  hardness: number
  /** 橡皮擦（destination-out）：paint 模式擦未保存涂抹笔画、mask 模式擦 mask。 */
  erase?: boolean
  points: { x: number; y: number }[]
}

type InpaintPoint = InpaintStroke['points'][number]

export type InpaintMode = 'paint' | 'mask'
export type InpaintTool = 'brush' | 'eraser' | 'lasso'

export interface LassoPoint {
  id: string
  x: number
  y: number
  /** Smooth points curve both adjacent segments; corner points stay straight. */
  smooth: boolean
}

export interface LassoShape {
  id: string
  points: LassoPoint[]
  /** Captured when a paint-mode lasso is closed. Mask-mode lassos ignore it. */
  color: string
}

export type PaintEdit =
  | { type: 'stroke'; stroke: InpaintStroke }
  | { type: 'lasso'; shape: LassoShape }

export interface HeadMaskOverlayRegion {
  bitmap?: { url: string; origin: [number, number]; size: [number, number] }
  id: string
  score?: number
  selected: boolean
  mask_region: { x1: number; y1: number; x2: number; y2: number; feather_x?: number; feather_y?: number }
}

export interface AutoMaskRegion {
  x1: number
  y1: number
  x2: number
  y2: number
  feather_x: number
  feather_y: number
}

export type MaskEdit =
  | { type: 'stroke'; stroke: InpaintStroke }
  | { type: 'auto'; regions: AutoMaskRegion[] }
  | { type: 'lasso'; shape: LassoShape }
export interface InpaintCanvasHandle {
  /** 当前图 + 全部涂抹笔画合成导出 PNG。图片未加载完成时返回 null。 */
  exportBlob: () => Promise<Blob | null>
  /** mask 层导出灰度 PNG（255=学 0=不学）+ 覆盖率。
   *  mask 为空（全学）→ null（调用方应 DELETE 而不是写全白文件）。 */
  exportMaskBlob: () => Promise<{ blob: Blob; coverage: number } | null>
  /** Cancel an open lasso or point selection before an owning dialog closes. */
  cancelTransientEdit: () => boolean
  /** Clear the transient endpoint used by Shift-click straight strokes. */
  resetStrokeAnchor: () => void
}

export interface BrushAdjustment {
  size: number
  hardness: number
}

export type BrushAdjustmentAxis = 'pending' | 'size' | 'hardness'

export interface StraightStrokeGuideGeometry {
  radius: number
  sides: [
    { x1: number; y1: number; x2: number; y2: number },
    { x1: number; y1: number; x2: number; y2: number },
  ]
}

const MIN_BRUSH_SIZE = 1
const MAX_BRUSH_SIZE = 400
const BRUSH_ADJUST_DEAD_ZONE = 6
const BRUSH_ADJUST_AXIS_DOMINANCE = 1.25
const BRUSH_HUD_GAP = 8
const BRUSH_HUD_WIDTH = 132
const BRUSH_HUD_HEIGHT = 44
const STRAIGHT_GUIDE_DASH = 6
const STRAIGHT_GUIDE_GAP = 4
const STRAIGHT_GUIDE_OUTLINE_WIDTH = 3.5
const STRAIGHT_GUIDE_FOREGROUND_WIDTH = 1.5
const LASSO_CLOSE_RADIUS = 10
const LASSO_POINT_RADIUS = 5

let lassoIdSequence = 0
function createLassoId(prefix: 'shape' | 'point'): string {
  lassoIdSequence += 1
  return `${prefix}-${Date.now().toString(36)}-${lassoIdSequence.toString(36)}`
}

/** Wait for a deliberate dominant direction before locking the whole gesture
 * to one parameter. Near-diagonal movement remains pending. */
export function resolveBrushAdjustmentAxis(
  deltaX: number,
  deltaY: number,
): BrushAdjustmentAxis {
  const absX = Math.abs(deltaX)
  const absY = Math.abs(deltaY)
  if (Math.max(absX, absY) < BRUSH_ADJUST_DEAD_ZONE) return 'pending'
  if (absX >= absY * BRUSH_ADJUST_AXIS_DOMINANCE) return 'size'
  if (absY >= absX * BRUSH_ADJUST_AXIS_DOMINANCE) return 'hardness'
  return 'pending'
}

function removeBrushAdjustDeadZone(delta: number): number {
  return Math.sign(delta) * Math.max(0, Math.abs(delta) - BRUSH_ADJUST_DEAD_ZONE)
}

/** Apply only the locked axis. The startup dead zone is subtracted so the
 * value does not jump when the direction first becomes clear. */
export function resolveBrushAdjustment(
  initial: BrushAdjustment,
  deltaX: number,
  deltaY: number,
  scale: number,
  axis: BrushAdjustmentAxis,
): BrushAdjustment {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1
  if (axis === 'pending') return initial
  return {
    size: axis === 'size'
      ? Math.max(MIN_BRUSH_SIZE, Math.min(
        MAX_BRUSH_SIZE,
        Math.round(initial.size + removeBrushAdjustDeadZone(deltaX) / safeScale),
      ))
      : initial.size,
    hardness: axis === 'hardness'
      ? Math.max(0, Math.min(
        1,
        Math.round(initial.hardness * 100 - removeBrushAdjustDeadZone(deltaY)) / 100,
      ))
      : initial.hardness,
  }
}

export function resolveStraightStrokeGuide(
  start: { x: number; y: number },
  end: { x: number; y: number },
  brushSize: number,
  scale: number,
): StraightStrokeGuideGeometry | null {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1
  if (!Number.isFinite(length) || length * safeScale < 1 || brushSize <= 0) return null
  const radius = brushSize / 2
  const offsetX = (-dy / length) * radius
  const offsetY = (dx / length) * radius
  return {
    radius,
    sides: [
      {
        x1: start.x + offsetX,
        y1: start.y + offsetY,
        x2: end.x + offsetX,
        y2: end.y + offsetY,
      },
      {
        x1: start.x - offsetX,
        y1: start.y - offsetY,
        x2: end.x - offsetX,
        y2: end.y - offsetY,
      },
    ],
  }
}

function strokePath(ctx: CanvasRenderingContext2D, s: InpaintStroke, color?: string): void {
  const c = color ?? s.color
  ctx.strokeStyle = c
  ctx.fillStyle = c
  ctx.lineWidth = s.size
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const pts = s.points
  if (pts.length === 0) return
  if (pts.length === 1) {
    ctx.beginPath()
    ctx.arc(pts[0].x, pts[0].y, s.size / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.stroke()
}

/** Trace a closed polygon whose smooth anchors use Catmull-Rom-derived cubic
 * handles. A smooth anchor affects the segment entering and leaving it. */
function lassoSegmentControls(points: LassoPoint[], i: number) {
  const j = (i + 1) % points.length
  const a = points[i]
  const b = points[j]
  const prevA = points[(i - 1 + points.length) % points.length]
  const nextB = points[(j + 1) % points.length]
  return {
    a,
    b,
    curved: a.smooth || b.smooth,
    cp1: a.smooth
      ? { x: a.x + (b.x - prevA.x) / 6, y: a.y + (b.y - prevA.y) / 6 }
      : a,
    cp2: b.smooth
      ? { x: b.x - (nextB.x - a.x) / 6, y: b.y - (nextB.y - a.y) / 6 }
      : b,
  }
}

export function traceLassoPath(
  ctx: Pick<CanvasRenderingContext2D,
    'beginPath' | 'moveTo' | 'lineTo' | 'bezierCurveTo' | 'closePath'>,
  shape: LassoShape,
): boolean {
  const points = shape.points
  if (points.length < 3) return false
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (let i = 0; i < points.length; i++) {
    const { b, curved, cp1, cp2 } = lassoSegmentControls(points, i)
    if (!curved) {
      ctx.lineTo(b.x, b.y)
      continue
    }
    ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, b.x, b.y)
  }
  ctx.closePath()
  return true
}

function lassoPathData(shape: LassoShape): string {
  const points = shape.points
  if (points.length < 3) return ''
  const commands = [`M ${points[0].x} ${points[0].y}`]
  for (let i = 0; i < points.length; i++) {
    const { b, curved, cp1, cp2 } = lassoSegmentControls(points, i)
    commands.push(curved
      ? `C ${cp1.x} ${cp1.y} ${cp2.x} ${cp2.y} ${b.x} ${b.y}`
      : `L ${b.x} ${b.y}`)
  }
  commands.push('Z')
  return commands.join(' ')
}

function drawLassoShape(
  ctx: CanvasRenderingContext2D,
  shape: LassoShape,
  color: string,
): void {
  ctx.save()
  ctx.fillStyle = color
  if (traceLassoPath(ctx, shape)) ctx.fill('evenodd')
  ctx.restore()
}

type ScratchRef = { current: HTMLCanvasElement | null }

/** 画一笔（含软边：经复用 scratch canvas + blur filter 合成）。 */
function drawOneStroke(
  ctx: CanvasRenderingContext2D,
  s: InpaintStroke,
  color: string,
  holder: ScratchRef,
): void {
  if (s.hardness >= 1 || s.points.length === 0) {
    strokePath(ctx, s, color)
    return
  }
  const w = ctx.canvas.width
  const h = ctx.canvas.height
  if (!holder.current || holder.current.width !== w || holder.current.height !== h) {
    holder.current = document.createElement('canvas')
    holder.current.width = w
    holder.current.height = h
  }
  const sctx = holder.current.getContext('2d')
  if (!sctx) {
    strokePath(ctx, s, color)
    return
  }
  sctx.clearRect(0, 0, w, h)
  strokePath(sctx, s, color)
  const blur = (s.size * (1 - s.hardness)) / 2
  ctx.save()
  ctx.filter = `blur(${blur}px)`
  ctx.drawImage(holder.current, 0, 0)
  ctx.restore()
}

/** 重放笔画到独立 layer（erase 走 destination-out —— 涂抹橡皮擦掉的是
 *  未保存笔画露出底图，mask 橡皮擦掉 mask，两者语义一致）。 */
function drawStrokesToLayer(
  ctx: CanvasRenderingContext2D,
  strokes: InpaintStroke[],
  scratchRef: ScratchRef,
  colorOf: (s: InpaintStroke) => string,
): void {
  for (const s of strokes) {
    ctx.save()
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over'
    drawOneStroke(ctx, s, colorOf(s), scratchRef)
    ctx.restore()
  }
}

function drawPaintEdits(
  ctx: CanvasRenderingContext2D,
  edits: PaintEdit[],
  scratchRef: ScratchRef,
): void {
  for (const edit of edits) {
    if (edit.type === 'lasso') drawLassoShape(ctx, edit.shape, edit.shape.color)
    else drawStrokesToLayer(ctx, [edit.stroke], scratchRef, (s) => s.color)
  }
}

function drawMaskStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: InpaintStroke[],
  scratchRef: ScratchRef,
): void {
  drawStrokesToLayer(ctx, strokes, scratchRef, () => TRAINING_MASK_COLOR)
}

export function applyAutoMaskRegions(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  regions: AutoMaskRegion[],
): void {
  for (const region of regions) {
    const x1 = Math.max(0, Math.min(width, Math.trunc(region.x1)))
    const y1 = Math.max(0, Math.min(height, Math.trunc(region.y1)))
    const x2 = Math.max(x1, Math.min(width, Math.trunc(region.x2)))
    const y2 = Math.max(y1, Math.min(height, Math.trunc(region.y2)))
    const fx = Math.max(0, Math.trunc(region.feather_x || 0))
    const fy = Math.max(0, Math.trunc(region.feather_y || 0))
    if (x2 <= x1 || y2 <= y1) continue
    const ox1 = Math.max(0, x1 - fx)
    const oy1 = Math.max(0, y1 - fy)
    const ox2 = Math.min(width, x2 + fx)
    const oy2 = Math.min(height, y2 + fy)
    for (let y = oy1; y < oy2; y++) {
      for (let x = ox1; x < ox2; x++) {
        const dx = Math.max(x1 - x, x - (x2 - 1), 0)
        const dy = Math.max(y1 - y, y - (y2 - 1), 0)
        const nx = fx ? dx / fx : (dx > 0 ? 1 : 0)
        const ny = fy ? dy / fy : (dy > 0 ? 1 : 0)
        const alpha = Math.round((1 - Math.min(1, Math.max(nx, ny))) * 255)
        const index = (y * width + x) * 4
        if (alpha <= pixels[index + 3]) continue
        pixels[index] = 255
        pixels[index + 1] = 45
        pixels[index + 2] = 45
        pixels[index + 3] = alpha
      }
    }
  }
}

function drawAutoRegions(
  ctx: CanvasRenderingContext2D,
  regions: AutoMaskRegion[],
): void {
  const width = ctx.canvas.width
  const height = ctx.canvas.height
  const data = ctx.getImageData(0, 0, width, height)
  applyAutoMaskRegions(data.data, width, height, regions)
  ctx.putImageData(data, 0, 0)
}

function drawMaskEdits(
  ctx: CanvasRenderingContext2D,
  edits: MaskEdit[],
  scratchRef: ScratchRef,
): void {
  for (const edit of edits) {
    if (edit.type === 'auto') drawAutoRegions(ctx, edit.regions)
    else if (edit.type === 'lasso') drawLassoShape(ctx, edit.shape, TRAINING_MASK_COLOR)
    else drawMaskStrokes(ctx, [edit.stroke], scratchRef)
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`image load failed: ${url}`))
    img.src = url
  })
}

/** 重建 mask 层：底图（服务器已有 mask）+ 本地笔画。 */
function rebuildMaskLayer(
  layer: HTMLCanvasElement,
  base: HTMLCanvasElement | null,
  edits: MaskEdit[],
  scratchRef: ScratchRef,
): void {
  const ctx = layer.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, layer.width, layer.height)
  if (base) ctx.drawImage(base, 0, 0)
  drawMaskEdits(ctx, edits, scratchRef)
}

/** mask 层 → 灰度 PNG（255=学 0=不学）+ 覆盖率。全空 → null。 */
async function maskLayerToGray(
  layer: HTMLCanvasElement,
): Promise<{ blob: Blob; coverage: number } | null> {
  const ctx = layer.getContext('2d')
  if (!ctx) return null
  const data = ctx.getImageData(0, 0, layer.width, layer.height)
  const px = data.data
  let sum = 0
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]
    sum += a
    const v = 255 - a
    px[i] = v
    px[i + 1] = v
    px[i + 2] = v
    px[i + 3] = 255
  }
  const n = px.length / 4
  const coverage = sum / 255 / n
  if (sum === 0) return null
  const out = document.createElement('canvas')
  out.width = layer.width
  out.height = layer.height
  const octx = out.getContext('2d')
  if (!octx) return null
  octx.putImageData(data, 0, 0)
  const blob = await new Promise<Blob | null>((resolve) => {
    out.toBlob((b) => resolve(b), 'image/png')
  })
  return blob ? { blob, coverage } : null
}

/** 离屏重建 mask 并导出（「保存全部」对非活动图用）。null = mask 为空。 */
export async function renderMaskBlob(
  maskBaseUrl: string | null,
  w: number,
  h: number,
  edits: MaskEdit[],
): Promise<{ blob: Blob; coverage: number } | null> {
  const layer = document.createElement('canvas')
  layer.width = w
  layer.height = h
  const base = maskBaseUrl ? await loadTrainingMaskPreview(maskBaseUrl, w, h) : null
  rebuildMaskLayer(layer, base, edits, { current: null })
  return await maskLayerToGray(layer)
}

/** 离屏重放涂抹：加载原图 → layer 重放笔画（含橡皮）→ 合成 PNG blob。 */
export async function renderInpaintedBlob(
  imageUrl: string,
  w: number,
  h: number,
  edits: PaintEdit[],
): Promise<Blob> {
  const img = await loadImage(imageUrl)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  ctx.drawImage(img, 0, 0, w, h)
  const layer = document.createElement('canvas')
  layer.width = w
  layer.height = h
  const lctx = layer.getContext('2d')
  if (!lctx) throw new Error('canvas 2d context unavailable')
  drawPaintEdits(lctx, edits, { current: null })
  ctx.drawImage(layer, 0, 0)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/png',
    )
  })
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => v.toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** 涂抹主画布：原图分辨率 canvas + useZoomPan 视口（空格 / 中键 pan）。
 *
 *  两个数据面（双桶受控）：
 *  - 涂抹笔画（strokes）：直接覆盖像素，重绘顺序 img → strokes。
 *  - mask edits（maskEdits）+ 服务器底图（maskBaseUrl）：合成到独立
 *    maskLayer（红色 alpha 位图），主画布最后以半透明叠加显示。
 *
 *  绘制中在独立预览画布增量绘制，pointerup 提交后由 props 变化触发
 *  正式图层的全量重绘。
 */
const InpaintCanvas = forwardRef<
  InpaintCanvasHandle,
  {
    imageUrl: string
    imageW: number
    imageH: number
    mode: InpaintMode
    paintEdits: PaintEdit[]
    maskEdits: MaskEdit[]
    /** 服务器已有 mask 的 URL；null = 无底图。 */
    maskBaseUrl: string | null
    brush: { color: string; size: number; hardness: number }
    /** Alt + right-drag updates the shared, controlled brush preferences. */
    onBrushAdjust: (next: BrushAdjustment) => void
    tool: InpaintTool
    onStrokeEnd: (s: InpaintStroke) => void
    onMaskStrokeEnd: (s: InpaintStroke) => void
    onLassoCreate: (mode: InpaintMode, shape: LassoShape) => void
    onLassoUpdate: (mode: InpaintMode, shape: LassoShape) => void
    onLassoDelete: (mode: InpaintMode, shapeId: string) => void
    onPickColor: (hex: string) => void
    /** Proposal-only overlay. It is never included in image or mask exports. */
    proposalRegions?: HeadMaskOverlayRegion[]
    onProposalPreviewState?: (state: 'loading' | 'ready' | 'error') => void
    /** Optional external host for the zoom/coordinates readout. Undefined
     * keeps the bar directly below the canvas; null hides it until mounted. */
    statusBarPortalTarget?: HTMLElement | null
  }
>(function InpaintCanvas(
  {
    imageUrl, imageW, imageH, mode, paintEdits, maskEdits, maskBaseUrl,
    brush, onBrushAdjust, tool, onStrokeEnd, onMaskStrokeEnd,
    onLassoCreate, onLassoUpdate, onLassoDelete, onPickColor,
    proposalRegions = [],
    onProposalPreviewState,
    statusBarPortalTarget,
  },
  ref,
) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const strokePreviewRef = useRef<HTMLCanvasElement | null>(null)
  const cursorRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const scratchRef = useRef<HTMLCanvasElement | null>(null)
  const paintLayerRef = useRef<HTMLCanvasElement | null>(null)
  const maskLayerRef = useRef<HTMLCanvasElement | null>(null)
  const maskBaseRef = useRef<HTMLCanvasElement | null>(null)
  const contextMenuResetRef = useRef<number | null>(null)
  const strokePreviewClearFrameRef = useRef<number | null>(null)

  // 视口（zoom / pan / fit / 坐标换算）走共享 hook；画笔类场景左键留给
  // 画笔（primaryButtonPans 缺省 false），pan 由空格 / 中键触发。
  const zp = useZoomPan({
    contentW: imageW,
    contentH: imageH,
    spacePanScope: 'viewport',
  })
  const { wrapRef, contentRef, toContentPoint } = zp

  // 落笔时锁定归属（paint / mask），松手按此提交 —— 不事后按 mode 猜
  const drawingRef = useRef<{
    stroke: InpaintStroke
    target: InpaintMode
    /** Shift-click strokes keep the pointer-down endpoint even if the mouse moves. */
    fixedEndpoint: boolean
  } | null>(null)
  const lastStrokePointRef = useRef<InpaintPoint | null>(null)

  const [loaded, setLoaded] = useState(false)
  const [maskBaseTick, setMaskBaseTick] = useState(0)
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null)
  const [straightGuidePoint, setStraightGuidePoint] = useState<InpaintPoint | null>(null)
  const [straightGuideActive, setStraightGuideActive] = useState(false)
  const [brushHud, setBrushHud] = useState<(
    BrushAdjustment & { left: number; top: number; axis: BrushAdjustmentAxis }
  ) | null>(null)
  const [lassoDraft, setLassoDraft] = useState<LassoShape | null>(null)
  const [selectedLassoPoint, setSelectedLassoPoint] = useState<{
    mode: InpaintMode
    shapeId: string
    pointId: string
  } | null>(null)
  const [lassoPreview, setLassoPreview] = useState<{
    mode: InpaintMode
    shape: LassoShape
  } | null>(null)

  const paintEditsRef = useRef(paintEdits)
  paintEditsRef.current = paintEdits
  const maskEditsRef = useRef(maskEdits)
  maskEditsRef.current = maskEdits
  const brushRef = useRef(brush)
  brushRef.current = brush
  const modeRef = useRef(mode)
  modeRef.current = mode
  const toolRef = useRef(tool)
  toolRef.current = tool
  const proposalBitmaps = useRef(new Map<string, ImageData>())
  const proposalUnion = useRef<HTMLCanvasElement | null>(null)
  const brushAdjustRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    initial: BrushAdjustment
    axis: BrushAdjustmentAxis
    lastPublished: BrushAdjustment
  } | null>(null)
  const suppressContextMenuRef = useRef(false)
  const pressedShiftKeysRef = useRef(new Set<string>())
  const lassoDragRef = useRef<{
    pointerId: number
    mode: InpaintMode
    original: LassoShape
    current: LassoShape
    pointId: string
    changed: boolean
  } | null>(null)

  const displayedPaintEdits = useMemo(() => paintEdits.map((edit) => (
    edit.type === 'lasso' && lassoPreview?.mode === 'paint' && edit.shape.id === lassoPreview.shape.id
      ? { ...edit, shape: lassoPreview.shape }
      : edit
  )), [paintEdits, lassoPreview])
  const displayedMaskEdits = useMemo(() => maskEdits.map((edit) => (
    edit.type === 'lasso' && lassoPreview?.mode === 'mask' && edit.shape.id === lassoPreview.shape.id
      ? { ...edit, shape: lassoPreview.shape }
      : edit
  )), [maskEdits, lassoPreview])
  const editableLassos = useMemo(() => (
    mode === 'paint' ? displayedPaintEdits : displayedMaskEdits
  ).flatMap((edit) => edit.type === 'lasso' ? [edit.shape] : []), [
    displayedMaskEdits, displayedPaintEdits, mode,
  ])

  const ensureLayer = useCallback((
    holder: React.MutableRefObject<HTMLCanvasElement | null>,
  ): HTMLCanvasElement => {
    if (
      !holder.current ||
      holder.current.width !== imageW ||
      holder.current.height !== imageH
    ) {
      const c = document.createElement('canvas')
      c.width = imageW
      c.height = imageH
      holder.current = c
    }
    return holder.current
  }, [imageW, imageH])

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const paintLayer = paintLayerRef.current
    if (paintLayer) ctx.drawImage(paintLayer, 0, 0)
    const layer = maskLayerRef.current
    if (layer) {
      ctx.save()
      ctx.globalAlpha = TRAINING_MASK_VIEW_ALPHA
      ctx.drawImage(layer, 0, 0)
      ctx.restore()
    }
    if (proposalUnion.current) {
      ctx.save()
      ctx.globalAlpha = 0.55
      ctx.drawImage(proposalUnion.current, 0, 0)
      ctx.restore()
    }
  }, [])

  const clearStrokePreview = useCallback(() => {
    const preview = strokePreviewRef.current
    const ctx = preview?.getContext('2d')
    if (!preview || !ctx) return
    ctx.clearRect(0, 0, preview.width, preview.height)
  }, [])

  const configureStrokePreview = useCallback((drawing: {
    stroke: InpaintStroke
    target: InpaintMode
  }) => {
    const preview = strokePreviewRef.current
    if (!preview) return
    const blur = (drawing.stroke.size * (1 - drawing.stroke.hardness)) / 2
    preview.style.filter = blur > 0 ? `blur(${blur}px)` : 'none'
    preview.style.opacity = drawing.stroke.erase
      ? '0.5'
      : drawing.target === 'mask' ? String(TRAINING_MASK_VIEW_ALPHA) : '1'
  }, [])

  /** Keep the in-progress stroke off the composited canvas. Opacity and soft
   * edges belong to the whole preview layer instead of every sampled segment,
   * so overlapping round caps cannot pulse darker while the pointer moves. */
  const beginStrokePreview = useCallback((drawing: {
    stroke: InpaintStroke
    target: InpaintMode
  }) => {
    const preview = strokePreviewRef.current
    const ctx = preview?.getContext('2d')
    if (!preview || !ctx) return
    clearStrokePreview()
    configureStrokePreview(drawing)
    const color = drawing.stroke.erase
      ? '#ffffff'
      : drawing.target === 'mask' ? TRAINING_MASK_COLOR : drawing.stroke.color
    strokePath(ctx, drawing.stroke, color)
  }, [clearStrokePreview, configureStrokePreview])

  const extendStrokePreview = useCallback((
    drawing: { stroke: InpaintStroke; target: InpaintMode },
    from: InpaintPoint,
    to: InpaintPoint,
  ) => {
    const ctx = strokePreviewRef.current?.getContext('2d')
    if (!ctx) return
    const color = drawing.stroke.erase
      ? '#ffffff'
      : drawing.target === 'mask' ? TRAINING_MASK_COLOR : drawing.stroke.color
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = drawing.stroke.size
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
    ctx.restore()
  }, [])

  // 图片加载（imageUrl 变化 = 换图或保存后 mtime 刷新）
  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    imgRef.current = null
    drawingRef.current = null
    clearStrokePreview()
    loadImage(imageUrl).then(
      (img) => {
        if (cancelled) return
        imgRef.current = img
        setLoaded(true)
        zp.fit()
        redraw()
      },
      () => {
        /* 失败留空画布；filmstrip 换图可恢复 */
      },
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl, zp.fit, redraw, clearStrokePreview])

  // mask 底图加载（URL 变化 = 换图 / 保存后刷新 / 本地清除→null）
  useEffect(() => {
    let cancelled = false
    maskBaseRef.current = null
    if (!maskBaseUrl) {
      setMaskBaseTick((v) => v + 1)
      return
    }
    void loadTrainingMaskPreview(maskBaseUrl, imageW, imageH).then((base) => {
      if (cancelled) return
      maskBaseRef.current = base
      setMaskBaseTick((v) => v + 1)
    })
    return () => {
      cancelled = true
    }
  }, [maskBaseUrl, imageW, imageH])

  // mask 层重建（底图 / 笔画变化）→ 主画布重绘
  useEffect(() => {
    const layer = ensureLayer(maskLayerRef)
    rebuildMaskLayer(layer, maskBaseRef.current, displayedMaskEdits, scratchRef)
    redraw()
    if (!drawingRef.current) clearStrokePreview()
  }, [displayedMaskEdits, maskBaseTick, ensureLayer, redraw, clearStrokePreview])

  // 涂抹层重建（undo / redo / 落笔提交 / 清除 —— 含橡皮 composite）
  useEffect(() => {
    const layer = ensureLayer(paintLayerRef)
    const ctx = layer.getContext('2d')
    if (ctx) {
      ctx.clearRect(0, 0, layer.width, layer.height)
      drawPaintEdits(ctx, displayedPaintEdits, scratchRef)
    }
    redraw()
    if (!drawingRef.current) clearStrokePreview()
  }, [displayedPaintEdits, ensureLayer, redraw, clearStrokePreview])

  useEffect(() => {
    let active = true
    const selected = proposalRegions.filter((region) => region.selected)
    const urls = new Set(selected.flatMap((r) => r.bitmap ? [r.bitmap.url] : []))
    for (const key of proposalBitmaps.current.keys()) {
      if (!urls.has(key)) proposalBitmaps.current.delete(key)
    }
    let remaining = [...urls].filter((url) => !proposalBitmaps.current.has(url)).length
    let failed = false
    const rebuild = () => {
      if (!active) return
      proposalUnion.current = null
      if (selected.length && imageW > 0 && imageH > 0) {
        try {
          const layer = document.createElement('canvas')
          layer.width = imageW
          layer.height = imageH
          const context = layer.getContext('2d')
          if (!context) throw new Error('Canvas unavailable')
          const pixels = context.getImageData(0, 0, imageW, imageH)
          for (const region of selected) {
            if (region.bitmap) {
              const bitmap = proposalBitmaps.current.get(region.bitmap.url)
              if (!bitmap) continue
              if (bitmap.width !== region.bitmap.size[0] || bitmap.height !== region.bitmap.size[1]) {
                throw new Error('Mask bitmap size mismatch')
              }
              mergeProposalBitmap(pixels.data, imageW, imageH, bitmap, region.bitmap.origin)
            } else {
              applyAutoMaskRegions(pixels.data, imageW, imageH, [{
                ...region.mask_region, feather_x: region.mask_region.feather_x ?? 0, feather_y: region.mask_region.feather_y ?? 0,
              }])
            }
          }
          for (let i = 0; i < pixels.data.length; i += 4) {
            pixels.data[i] = 255; pixels.data[i + 1] = 168; pixels.data[i + 2] = 0
          }
          context.putImageData(pixels, 0, 0)
          proposalUnion.current = layer
        } catch { failed = true }
      }
      onProposalPreviewState?.(failed ? 'error' : remaining ? 'loading' : 'ready')
      redraw()
    }
    const settled = (error: boolean) => {
      if (!active) return
      failed ||= error
      remaining -= 1
      rebuild()
    }
    rebuild()
    for (const url of urls) {
      if (proposalBitmaps.current.has(url)) continue
      const image = new Image()
      image.onload = () => {
        if (!active) return
        try {
          const layer = document.createElement('canvas')
          layer.width = image.naturalWidth
          layer.height = image.naturalHeight
          const context = layer.getContext('2d')
          if (!context) throw new Error('Canvas unavailable')
          context.drawImage(image, 0, 0)
          proposalBitmaps.current.set(url, context.getImageData(0, 0, layer.width, layer.height))
          settled(false)
        } catch { settled(true) }
      }
      image.onerror = () => settled(true)
      image.src = url
    }
    return () => { active = false }
  }, [proposalRegions, imageW, imageH, redraw, onProposalPreviewState])

  useImperativeHandle(ref, () => ({
    exportBlob: async () => {
      const canvas = canvasRef.current
      const img = imgRef.current
      if (!canvas || !img) return null
      // 导出不含 mask overlay：干净重建 img + 涂抹层（含橡皮 composite）
      const out = document.createElement('canvas')
      out.width = canvas.width
      out.height = canvas.height
      const ctx = out.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(img, 0, 0, out.width, out.height)
      const layer = document.createElement('canvas')
      layer.width = out.width
      layer.height = out.height
      const lctx = layer.getContext('2d')
      if (!lctx) return null
      drawPaintEdits(lctx, paintEditsRef.current, scratchRef)
      ctx.drawImage(layer, 0, 0)
      return await new Promise<Blob | null>((resolve) => {
        out.toBlob((b) => resolve(b), 'image/png')
      })
    },
    exportMaskBlob: async () => {
      const layer = ensureLayer(maskLayerRef)
      rebuildMaskLayer(layer, maskBaseRef.current, maskEditsRef.current, scratchRef)
      return await maskLayerToGray(layer)
    },
    cancelTransientEdit: () => {
      const hadTransient = Boolean(lassoDraft || selectedLassoPoint || lassoDragRef.current)
      if (!hadTransient) return false
      setLassoDraft(null)
      setSelectedLassoPoint(null)
      setLassoPreview(null)
      lassoDragRef.current = null
      return true
    },
    resetStrokeAnchor: () => {
      lastStrokePointRef.current = null
      setStraightGuidePoint(null)
    },
  }), [ensureLayer, lassoDraft, selectedLassoPoint])

  // 笔刷圆圈光标（ref 直改 style；直径 = 笔刷 × 当前 scale）
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)
  const updateCursor = useCallback((
    clientX: number,
    clientY: number,
    size = brushRef.current.size,
  ) => {
    const cur = cursorRef.current
    const wrap = wrapRef.current
    if (!cur || !wrap) return
    lastPointerRef.current = { x: clientX, y: clientY }
    const rect = wrap.getBoundingClientRect()
    const d = size * zp.viewRef.current.scale
    cur.style.left = `${clientX - rect.left - d / 2}px`
    cur.style.top = `${clientY - rect.top - d / 2}px`
    cur.style.width = `${d}px`
    cur.style.height = `${d}px`
    cur.style.display = 'block'
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updateBrushHud = useCallback((
    clientX: number,
    clientY: number,
    next: BrushAdjustment,
    axis: BrushAdjustmentAxis,
  ) => {
    const wrap = wrapRef.current
    if (!wrap) return
    const diameter = next.size * zp.viewRef.current.scale
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    let left = clientX + diameter / 2 + BRUSH_HUD_GAP
    if (left + BRUSH_HUD_WIDTH > viewportWidth - BRUSH_HUD_GAP) {
      left = clientX - diameter / 2 - BRUSH_HUD_GAP - BRUSH_HUD_WIDTH
    }
    left = Math.max(
      BRUSH_HUD_GAP,
      Math.min(
        Math.max(BRUSH_HUD_GAP, viewportWidth - BRUSH_HUD_WIDTH - BRUSH_HUD_GAP),
        left,
      ),
    )

    let top = clientY - diameter / 2
    if (top < BRUSH_HUD_GAP) {
      top = clientY + diameter / 2 + BRUSH_HUD_GAP
    }
    top = Math.max(
      BRUSH_HUD_GAP,
      Math.min(
        Math.max(BRUSH_HUD_GAP, viewportHeight - BRUSH_HUD_HEIGHT - BRUSH_HUD_GAP),
        top,
      ),
    )

    setBrushHud({ ...next, left, top, axis })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // wheel 缩放后光标直径要跟 scale 变（hook 不知道光标 —— 用 zoomPct 变化
  // + 最后一次指针位置补一次更新）
  useEffect(() => {
    const p = lastPointerRef.current
    if (p) updateCursor(p.x, p.y)
  }, [zp.zoomPct, updateCursor])

  const pickColor = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current
      const pt = toContentPoint(clientX, clientY)
      if (!canvas || !pt) return
      const x = Math.round(pt.x)
      const y = Math.round(pt.y)
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const d = ctx.getImageData(x, y, 1, 1).data
      onPickColor(toHex(d[0], d[1], d[2]))
    },
    [toContentPoint, onPickColor],
  )

  const scheduleContextMenuReset = useCallback(() => {
    if (contextMenuResetRef.current != null) {
      window.clearTimeout(contextMenuResetRef.current)
    }
    contextMenuResetRef.current = window.setTimeout(() => {
      suppressContextMenuRef.current = false
      contextMenuResetRef.current = null
    }, 0)
  }, [])

  useEffect(() => () => {
    brushAdjustRef.current = null
    lassoDragRef.current = null
    drawingRef.current = null
    if (strokePreviewClearFrameRef.current != null) {
      window.cancelAnimationFrame(strokePreviewClearFrameRef.current)
    }
    if (contextMenuResetRef.current != null) {
      window.clearTimeout(contextMenuResetRef.current)
    }
  }, [])

  // An open path is deliberately local to the active image/mode/tool. Closed
  // shapes live in the page history and therefore survive ordinary redraws.
  useEffect(() => {
    setLassoDraft(null)
    setSelectedLassoPoint(null)
    setLassoPreview(null)
    lassoDragRef.current = null
  }, [mode, tool])

  // A straight-stroke anchor never crosses an image, mode, or tool boundary.
  useEffect(() => {
    lastStrokePointRef.current = null
    setStraightGuidePoint(null)
  }, [imageUrl, mode, tool])

  useEffect(() => {
    const pressedShiftKeys = pressedShiftKeysRef.current
    const isModifierCode = (code: string) => (
      code === 'ShiftLeft' || code === 'ShiftRight' ||
      code === 'ControlLeft' || code === 'ControlRight' ||
      code === 'AltLeft' || code === 'AltRight' ||
      code === 'MetaLeft' || code === 'MetaRight'
    )
    const sync = (event: KeyboardEvent) => {
      setStraightGuideActive(
        pressedShiftKeys.size > 0 &&
        !event.ctrlKey && !event.altKey && !event.metaKey,
      )
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isModifierCode(event.code) || event.isComposing) return
      if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
        pressedShiftKeys.add(event.code)
      }
      sync(event)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (!isModifierCode(event.code)) return
      if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
        pressedShiftKeys.delete(event.code)
      }
      sync(event)
    }
    const reset = () => {
      pressedShiftKeys.clear()
      setStraightGuideActive(false)
      setStraightGuidePoint(null)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') reset()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', reset)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', reset)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      pressedShiftKeys.clear()
    }
  }, [])

  useEffect(() => {
    if (tool !== 'lasso') return
    setBrushHud(null)
  }, [tool])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const wrap = wrapRef.current
      if (
        tool !== 'lasso' ||
        !wrap ||
        !wrap.contains(document.activeElement) ||
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey || event.altKey || event.metaKey || event.shiftKey ||
        hasBlockingVisibleModal(wrap)
      ) return
      if (event.code === 'Escape') {
        if (!lassoDraft && !selectedLassoPoint) return
        event.preventDefault()
        setLassoDraft(null)
        setSelectedLassoPoint(null)
        return
      }
      if (event.repeat || !selectedLassoPoint) return
      const shape = editableLassos.find((item) => item.id === selectedLassoPoint.shapeId)
      if (!shape) return
      if (event.code === 'Delete') {
        event.preventDefault()
        lassoDragRef.current = null
        setLassoPreview(null)
        setSelectedLassoPoint(null)
        onLassoDelete(selectedLassoPoint.mode, shape.id)
        return
      }
      if (event.code !== 'KeyC') return
      const pointIndex = shape.points.findIndex((point) => point.id === selectedLassoPoint.pointId)
      if (pointIndex < 0) return
      const points = shape.points.map((point, index) => index === pointIndex
        ? { ...point, smooth: !point.smooth }
        : point)
      event.preventDefault()
      onLassoUpdate(selectedLassoPoint.mode, { ...shape, points })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    editableLassos, lassoDraft, onLassoDelete, onLassoUpdate, selectedLassoPoint,
    tool, wrapRef,
  ])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!loaded) return
      e.currentTarget.focus({ preventScroll: true })
      if (
        toolRef.current !== 'lasso' &&
        e.pointerType === 'mouse' && e.button === 2 && e.altKey
      ) {
        e.preventDefault()
        if (contextMenuResetRef.current != null) {
          window.clearTimeout(contextMenuResetRef.current)
          contextMenuResetRef.current = null
        }
        suppressContextMenuRef.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        const initial = {
          size: brushRef.current.size,
          hardness: brushRef.current.hardness,
        }
        brushAdjustRef.current = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          initial,
          axis: 'pending',
          lastPublished: initial,
        }
        updateCursor(e.clientX, e.clientY, initial.size)
        updateBrushHud(e.clientX, e.clientY, initial, 'pending')
        return
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      // pan 手势（空格 / 中键）交给视口 hook；本组件只管画笔
      if (zp.panPointerDown(e)) return
      if (e.button !== 0) return
      if (e.altKey && modeRef.current === 'paint') {
        pickColor(e.clientX, e.clientY)
        return
      }
      const pt = toContentPoint(e.clientX, e.clientY)
      if (!pt) return
      if (pt.x < 0 || pt.y < 0 || pt.x > imageW || pt.y > imageH) return
      if (toolRef.current === 'lasso') {
        const scale = Math.max(0.0001, zp.viewRef.current.scale)
        const hitRadius = LASSO_CLOSE_RADIUS / scale
        const hit = [...editableLassos].reverse().flatMap((shape) => (
          [...shape.points].reverse().map((point) => ({ shape, point }))
        )).find(({ point }) => Math.hypot(point.x - pt.x, point.y - pt.y) <= hitRadius)
        if (hit) {
          setSelectedLassoPoint({ mode: modeRef.current, shapeId: hit.shape.id, pointId: hit.point.id })
          lassoDragRef.current = {
            pointerId: e.pointerId,
            mode: modeRef.current,
            original: hit.shape,
            current: hit.shape,
            pointId: hit.point.id,
            changed: false,
          }
          return
        }
        const first = lassoDraft?.points[0]
        if (
          first && lassoDraft.points.length >= 3 &&
          Math.hypot(first.x - pt.x, first.y - pt.y) <= hitRadius
        ) {
          const shape = { ...lassoDraft, color: brushRef.current.color }
          setLassoDraft(null)
          setSelectedLassoPoint({ mode: modeRef.current, shapeId: shape.id, pointId: first.id })
          onLassoCreate(modeRef.current, shape)
          return
        }
        const point: LassoPoint = {
          id: createLassoId('point'),
          x: pt.x,
          y: pt.y,
          smooth: false,
        }
        setSelectedLassoPoint(null)
        setLassoDraft((current) => current
          ? { ...current, points: [...current.points, point] }
          : {
              id: createLassoId('shape'),
              color: brushRef.current.color,
              points: [point],
            })
        return
      }
      const b = brushRef.current
      const isMask = modeRef.current === 'mask'
      const fixedEndpoint = e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
      const anchor = fixedEndpoint ? lastStrokePointRef.current : null
      const stroke: InpaintStroke = {
        color: isMask ? TRAINING_MASK_COLOR : b.color,
        size: b.size,
        hardness: b.hardness,
        ...(toolRef.current === 'eraser' ? { erase: true } : {}),
        points: anchor && (anchor.x !== pt.x || anchor.y !== pt.y)
          ? [{ ...anchor }, pt]
          : [pt],
      }
      drawingRef.current = {
        stroke,
        target: isMask ? 'mask' : 'paint',
        fixedEndpoint,
      }
      if (fixedEndpoint) {
        setStraightGuideActive(true)
        setStraightGuidePoint(pt)
        updateCursor(e.clientX, e.clientY)
      }
      if (strokePreviewClearFrameRef.current != null) {
        window.cancelAnimationFrame(strokePreviewClearFrameRef.current)
        strokePreviewClearFrameRef.current = null
      }
      beginStrokePreview(drawingRef.current)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      editableLassos, imageH, imageW, lassoDraft, loaded, onLassoCreate,
      beginStrokePreview, pickColor, toContentPoint, updateBrushHud, updateCursor,
      zp.panPointerDown,
    ],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const fixedEndpoint = drawingRef.current?.fixedEndpoint === true
      if (toolRef.current !== 'lasso' && !fixedEndpoint) {
        updateCursor(e.clientX, e.clientY)
      }
      const pt = toContentPoint(e.clientX, e.clientY)
      const pointInsideImage = Boolean(
        pt && pt.x >= 0 && pt.y >= 0 && pt.x <= imageW && pt.y <= imageH,
      )
      if (!fixedEndpoint) setStraightGuidePoint(pointInsideImage && pt ? pt : null)
      if (pt) {
        setCursorPos({
          x: Math.max(0, Math.min(imageW, Math.round(pt.x))),
          y: Math.max(0, Math.min(imageH, Math.round(pt.y))),
        })
      }
      const lassoDrag = lassoDragRef.current
      if (lassoDrag && lassoDrag.pointerId === e.pointerId && pt) {
        const x = Math.max(0, Math.min(imageW, pt.x))
        const y = Math.max(0, Math.min(imageH, pt.y))
        const points = lassoDrag.original.points.map((point) => point.id === lassoDrag.pointId
          ? { ...point, x, y }
          : point)
        const next = { ...lassoDrag.original, points }
        const originalPoint = lassoDrag.original.points.find((point) => point.id === lassoDrag.pointId)
        lassoDrag.changed = Boolean(originalPoint && (originalPoint.x !== x || originalPoint.y !== y))
        lassoDrag.current = next
        setLassoPreview({ mode: lassoDrag.mode, shape: next })
        return
      }
      const adjusting = brushAdjustRef.current
      if (adjusting && adjusting.pointerId === e.pointerId) {
        const deltaX = e.clientX - adjusting.startX
        const deltaY = e.clientY - adjusting.startY
        if (adjusting.axis === 'pending') {
          adjusting.axis = resolveBrushAdjustmentAxis(deltaX, deltaY)
        }
        const next = resolveBrushAdjustment(
          adjusting.initial,
          deltaX,
          deltaY,
          zp.viewRef.current.scale,
          adjusting.axis,
        )
        if (
          next.size !== adjusting.lastPublished.size ||
          next.hardness !== adjusting.lastPublished.hardness
        ) {
          adjusting.lastPublished = next
          brushRef.current = { ...brushRef.current, ...next }
          onBrushAdjust(next)
        }
        updateCursor(e.clientX, e.clientY, next.size)
        updateBrushHud(e.clientX, e.clientY, next, adjusting.axis)
        return
      }
      if (zp.panPointerMove(e)) {
        setStraightGuidePoint(null)
        return
      }
      const drawing = drawingRef.current
      if (!drawing || !pt) return
      if (drawing.fixedEndpoint) return
      const stroke = drawing.stroke
      const prev = stroke.points[stroke.points.length - 1]
      stroke.points.push(pt)
      extendStrokePreview(drawing, prev, pt)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      updateCursor, updateBrushHud, toContentPoint, imageW, imageH,
      extendStrokePreview, onBrushAdjust, zp.panPointerMove,
    ],
  )

  const endStroke = useCallback((cancelled = false) => {
    zp.endPan()
    const drawing = drawingRef.current
    drawingRef.current = null
    if (!drawing) return
    if (cancelled && drawing.fixedEndpoint) {
      clearStrokePreview()
      return
    }
    const endpoint = drawing.stroke.points[drawing.stroke.points.length - 1]
    if (endpoint) lastStrokePointRef.current = { ...endpoint }
    if (drawing.target === 'mask') onMaskStrokeEnd(drawing.stroke)
    else onStrokeEnd(drawing.stroke)
    // The controlled edit normally rebuilds its layer before the next frame.
    // Keep the preview until then to avoid a one-frame gap at pointer-up, with
    // a frame fallback for consumers that intentionally do not retain edits.
    strokePreviewClearFrameRef.current = window.requestAnimationFrame(() => {
      strokePreviewClearFrameRef.current = null
      clearStrokePreview()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearStrokePreview, onStrokeEnd, onMaskStrokeEnd, zp.endPan])

  const endInteraction = useCallback((
    e: React.PointerEvent<HTMLDivElement>,
    cancelled = false,
  ) => {
    const lassoDrag = lassoDragRef.current
    if (lassoDrag && lassoDrag.pointerId === e.pointerId) {
      lassoDragRef.current = null
      setLassoPreview(null)
      if (!cancelled && lassoDrag.changed) {
        onLassoUpdate(lassoDrag.mode, lassoDrag.current)
      }
      return
    }
    const adjusting = brushAdjustRef.current
    if (adjusting && adjusting.pointerId === e.pointerId) {
      brushAdjustRef.current = null
      setBrushHud(null)
      if (cancelled) suppressContextMenuRef.current = false
      else scheduleContextMenuReset()
      return
    }
    const fixedEndpoint = drawingRef.current?.fixedEndpoint === true
    endStroke(cancelled)
    if (fixedEndpoint) {
      if (cancelled) {
        setStraightGuidePoint(null)
      } else {
        const point = toContentPoint(e.clientX, e.clientY)
        const pointInsideImage = Boolean(
          point && point.x >= 0 && point.y >= 0 && point.x <= imageW && point.y <= imageH,
        )
        setStraightGuidePoint(pointInsideImage && point ? point : null)
        updateCursor(e.clientX, e.clientY)
      }
    }
  }, [
    endStroke, imageH, imageW, onLassoUpdate, scheduleContextMenuReset,
    toContentPoint, updateCursor,
  ])

  const onContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (toolRef.current === 'lasso') return
    if (!suppressContextMenuRef.current && !(e.altKey && e.button === 2)) return
    e.preventDefault()
    suppressContextMenuRef.current = false
    if (contextMenuResetRef.current != null) {
      window.clearTimeout(contextMenuResetRef.current)
      contextMenuResetRef.current = null
    }
  }, [])

  const lassoScale = Math.max(0.0001, zp.viewRef.current.scale)
  const draftPoints = lassoDraft
    ? [...lassoDraft.points, ...(cursorPos ? [{ ...cursorPos, id: 'cursor', smooth: false }] : [])]
    : []
  const erase = tool === 'eraser'
  const straightGuideStart = lastStrokePointRef.current
  const straightGuide = (
    straightGuideActive && loaded && tool !== 'lasso' && straightGuideStart &&
    straightGuidePoint && !zp.spacePressed && !zp.isPanning && !brushHud &&
    (!drawingRef.current || drawingRef.current.fixedEndpoint)
  ) ? resolveStraightStrokeGuide(
      straightGuideStart,
      straightGuidePoint,
      brush.size,
      lassoScale,
    ) : null
  const straightGuideColor = mode === 'mask' && !erase
    ? TRAINING_MASK_COLOR
    : '#ffffff'
  const straightGuideDash = `${STRAIGHT_GUIDE_DASH / lassoScale} ${STRAIGHT_GUIDE_GAP / lassoScale}`
  const statusBar = (
    <div
      data-testid="inpaint-canvas-status"
      className="shrink-0 flex items-center gap-2 text-[11px] font-mono text-fg-tertiary px-1"
    >
      <span>{zp.zoomPct}%</span>
      <button
        type="button"
        className="px-1.5 py-0.5 rounded hover:bg-overlay hover:text-fg-primary"
        onClick={() => zp.fit()}
      >{t('preprocessInpaint.zoomFit')}</button>
      <button
        type="button"
        className="px-1.5 py-0.5 rounded hover:bg-overlay hover:text-fg-primary"
        onClick={() => zp.reset100()}
      >100%</button>
      <span className="flex-1" />
      {cursorPos && (
        <span>{cursorPos.x}, {cursorPos.y}</span>
      )}
      <span>{imageW}×{imageH}</span>
      <span className="text-fg-disabled">
        {t(tool === 'lasso'
          ? 'preprocessInpaint.lassoCanvasHint'
          : 'preprocessInpaint.canvasHint')}
      </span>
    </div>
  )

  return (
    <div className="flex flex-col h-full min-h-0 gap-1.5">
      <div
        ref={wrapRef}
        className="relative flex-1 min-h-0 overflow-hidden rounded border border-subtle bg-sunken"
        style={{
          touchAction: 'none',
          cursor: zp.isPanning
            ? 'grabbing'
            : zp.spacePressed ? 'grab' : tool === 'lasso' ? 'crosshair' : 'none',
        }}
        tabIndex={0}
        aria-label={t('preprocessInpaint.canvasLabel')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endInteraction(e)}
        onPointerCancel={(e) => endInteraction(e, true)}
        onLostPointerCapture={(e) => endInteraction(e, true)}
        onContextMenu={onContextMenu}
        onPointerLeave={() => {
          const cur = cursorRef.current
          if (cur) {
            cur.style.display = 'none'
          }
          setCursorPos(null)
          setStraightGuidePoint(null)
        }}
      >
        <div
          ref={(el) => { contentRef.current = el }}
          style={{
            position: 'absolute', left: 0, top: 0,
            width: imageW, height: imageH, transformOrigin: '0 0',
          }}
        >
          <canvas
            ref={canvasRef}
            width={imageW}
            height={imageH}
            style={{ position: 'absolute', inset: 0 }}
          />
          <canvas
            ref={strokePreviewRef}
            data-testid="stroke-preview-canvas"
            width={imageW}
            height={imageH}
            className="pointer-events-none absolute inset-0"
            aria-hidden="true"
          />
          {straightGuide && straightGuideStart && (
            <svg
              data-testid="straight-stroke-guide"
              width={imageW}
              height={imageH}
              viewBox={`0 0 ${imageW} ${imageH}`}
              className="pointer-events-none absolute inset-0"
              aria-hidden="true"
            >
              <g
                fill="none"
                strokeLinecap="round"
                strokeDasharray={straightGuideDash}
              >
                <circle
                  cx={straightGuideStart.x}
                  cy={straightGuideStart.y}
                  r={straightGuide.radius}
                  stroke="rgba(0,0,0,0.78)"
                  strokeWidth={STRAIGHT_GUIDE_OUTLINE_WIDTH / lassoScale}
                />
                {straightGuide.sides.map((side, index) => (
                  <line
                    key={`outline-${index}`}
                    x1={side.x1}
                    y1={side.y1}
                    x2={side.x2}
                    y2={side.y2}
                    stroke="rgba(0,0,0,0.78)"
                    strokeWidth={STRAIGHT_GUIDE_OUTLINE_WIDTH / lassoScale}
                  />
                ))}
                <circle
                  data-testid="straight-stroke-guide-start"
                  cx={straightGuideStart.x}
                  cy={straightGuideStart.y}
                  r={straightGuide.radius}
                  stroke={straightGuideColor}
                  strokeOpacity={0.85}
                  strokeWidth={STRAIGHT_GUIDE_FOREGROUND_WIDTH / lassoScale}
                />
                {straightGuide.sides.map((side, index) => (
                  <line
                    key={`foreground-${index}`}
                    data-guide-side={index}
                    x1={side.x1}
                    y1={side.y1}
                    x2={side.x2}
                    y2={side.y2}
                    stroke={straightGuideColor}
                    strokeOpacity={0.9}
                    strokeWidth={STRAIGHT_GUIDE_FOREGROUND_WIDTH / lassoScale}
                  />
                ))}
              </g>
            </svg>
          )}
          {tool === 'lasso' && (
            <svg
              data-testid="lasso-overlay"
              width={imageW}
              height={imageH}
              viewBox={`0 0 ${imageW} ${imageH}`}
              className="absolute inset-0 pointer-events-none text-accent"
              aria-hidden="true"
            >
              {editableLassos.map((shape) => (
                <g key={shape.id} data-lasso-id={shape.id}>
                  <path
                    d={lassoPathData(shape)}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5 / lassoScale}
                  />
                  {shape.points.map((point) => {
                    const selected = selectedLassoPoint?.shapeId === shape.id
                      && selectedLassoPoint.pointId === point.id
                    return (
                      <circle
                        key={point.id}
                        data-lasso-point-id={point.id}
                        data-smooth={String(point.smooth)}
                        cx={point.x}
                        cy={point.y}
                        r={(selected ? 7 : LASSO_POINT_RADIUS) / lassoScale}
                        fill={selected ? '#ffffff' : point.smooth ? '#38bdf8' : '#111827'}
                        stroke="#38bdf8"
                        strokeWidth={(selected ? 2 : 1.5) / lassoScale}
                      />
                    )
                  })}
                </g>
              ))}
              {lassoDraft && (
                <g data-testid="lasso-draft">
                  <polyline
                    points={draftPoints.map((point) => `${point.x},${point.y}`).join(' ')}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5 / lassoScale}
                    strokeDasharray={`${5 / lassoScale} ${4 / lassoScale}`}
                  />
                  {lassoDraft.points.map((point, index) => (
                    <circle
                      key={point.id}
                      cx={point.x}
                      cy={point.y}
                      r={(index === 0 && lassoDraft.points.length >= 3 ? 7 : LASSO_POINT_RADIUS) / lassoScale}
                      fill={index === 0 ? '#ffffff' : '#111827'}
                      stroke="#38bdf8"
                      strokeWidth={1.5 / lassoScale}
                    />
                  ))}
                </g>
              )}
            </svg>
          )}
        </div>
        {/* 套索不挂载圆形光标，避免 0×0 元素的边框残留成一个点。 */}
        {tool !== 'lasso' && <div
          ref={cursorRef}
          data-testid="brush-cursor"
          className="absolute pointer-events-none rounded-full"
          style={{
            display: 'none',
            opacity: zp.spacePressed || zp.isPanning ? 0 : 1,
            border: mode === 'mask' && !erase
              ? '1.5px solid rgba(255,45,45,0.95)'
              : `1.5px ${erase ? 'dashed' : 'solid'} rgba(255,255,255,0.9)`,
            outline: '1px solid rgba(0,0,0,0.6)',
          }}
        />}
        {brushHud && createPortal(
          <div
            data-testid="brush-adjust-hud"
            aria-hidden="true"
            className="fixed z-[80] pointer-events-none rounded border border-strong bg-elevated px-2 py-1 text-[11px] font-mono leading-4 text-fg-primary shadow-lg whitespace-nowrap"
            style={{ left: brushHud.left, top: brushHud.top, minWidth: BRUSH_HUD_WIDTH }}
          >
            <div className={brushHud.axis === 'size'
              ? 'font-semibold text-accent'
              : brushHud.axis === 'hardness' ? 'text-fg-disabled' : undefined}
            >{t('preprocessInpaint.brushDiameterHud', { size: brushHud.size })}</div>
            <div className={brushHud.axis === 'hardness'
              ? 'font-semibold text-accent'
              : brushHud.axis === 'size' ? 'text-fg-disabled' : undefined}
            >{t('preprocessInpaint.brushHardnessHud', {
              hardness: Math.round(brushHud.hardness * 100),
            })}</div>
          </div>,
          document.body,
        )}
        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center text-fg-tertiary text-sm">
            {t('preprocessInpaint.canvasLoading')}
          </div>
        )}
      </div>

      {/* readout 细条：默认在画布下方，也可传送到外部两栏布局底部。 */}
      {statusBarPortalTarget === undefined
        ? statusBar
        : statusBarPortalTarget ? createPortal(statusBar, statusBarPortalTarget) : null}
    </div>
  )
})

export default InpaintCanvas
