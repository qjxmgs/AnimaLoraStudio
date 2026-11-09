import { useEffect, useRef, useState, type RefObject } from 'react'

interface Point { x: number; y: number }
interface Box { left: number; top: number; width: number; height: number }
export interface GridGeometry {
  left: number; top: number; width: number; height: number
  columns: number; columnGap: number; rowGap: number
}

export function marqueeHits(names: readonly string[], grid: GridGeometry, start: Point, end: Point): Set<string> {
  const left = Math.min(start.x, end.x), right = Math.max(start.x, end.x)
  const top = Math.min(start.y, end.y), bottom = Math.max(start.y, end.y)
  return new Set(names.filter((_, index) => {
    const x = grid.left + (index % grid.columns) * (grid.width + grid.columnGap)
    const y = grid.top + Math.floor(index / grid.columns) * (grid.height + grid.rowGap)
    return x < right && x + grid.width > left && y < bottom && y + grid.height > top
  }))
}

/** Opt-in mouse marquee. Geometry covers virtualized rows, not just mounted DOM.
 * Keep a local preview until mouse-up so parent panels cannot resize mid-drag.
 */
export function useGridMarquee(
  rootRef: RefObject<HTMLDivElement>,
  names: readonly string[],
  selected: Set<string>,
  onChange?: (selected: Set<string>) => void,
) {
  const scrollerRef = useRef<HTMLElement | null>(null)
  const latest = useRef({ selected, onChange })
  useEffect(() => { latest.current = { selected, onChange } }, [selected, onChange])
  const [preview, setPreview] = useState<Set<string> | null>(null)
  const [box, setBox] = useState<Box | null>(null)
  const enabled = !!onChange

  useEffect(() => {
    const root = rootRef.current
    if (!enabled || !root) return
    let drag: {
      origin: Point; client: Point; initialClient: Point; grid: GridGeometry
      base: Set<string>; active: boolean; result: Set<string>; scroll: HTMLElement
    } | null = null
    let frame = 0
    let suppressClick = false
    let clickTimer = 0

    const point = (client: Point, scroll: HTMLElement): Point => {
      const rect = scroll.getBoundingClientRect()
      return {
        x: Math.max(0, Math.min(scroll.clientWidth, client.x - rect.left)) + scroll.scrollLeft,
        y: Math.max(0, Math.min(scroll.clientHeight, client.y - rect.top)) + scroll.scrollTop,
      }
    }
    const update = () => {
      if (!drag?.active) return
      const end = point(drag.client, drag.scroll)
      const hits = marqueeHits(names, drag.grid, drag.origin, end)
      drag.result = new Set([...drag.base, ...hits])
      setPreview(drag.result)
      const view = drag.scroll.getBoundingClientRect(), rootBox = root.getBoundingClientRect()
      const left = Math.max(0, Math.min(drag.origin.x, end.x) - drag.scroll.scrollLeft)
      const top = Math.max(0, Math.min(drag.origin.y, end.y) - drag.scroll.scrollTop)
      const right = Math.min(drag.scroll.clientWidth, Math.max(drag.origin.x, end.x) - drag.scroll.scrollLeft)
      const bottom = Math.min(drag.scroll.clientHeight, Math.max(drag.origin.y, end.y) - drag.scroll.scrollTop)
      setBox({ left: left + view.left - rootBox.left, top: top + view.top - rootBox.top,
        width: Math.max(0, right - left), height: Math.max(0, bottom - top) })
    }
    const tick = () => {
      if (!drag?.active) return
      const rect = drag.scroll.getBoundingClientRect()
      const y = drag.client.y - rect.top
      const delta = y < 32 ? -12 : y > drag.scroll.clientHeight - 32 ? 12 : 0
      if (delta) drag.scroll.scrollTop += delta
      update()
      frame = requestAnimationFrame(tick)
    }
    const finish = (commit: boolean) => {
      if (!drag) return
      const current = drag
      drag = null
      cancelAnimationFrame(frame)
      setPreview(null)
      setBox(null)
      if (current.active) {
        suppressClick = true
        window.clearTimeout(clickTimer)
        clickTimer = window.setTimeout(() => { suppressClick = false }, 0)
        if (commit) latest.current.onChange?.(current.result)
      }
    }
    const down = (event: MouseEvent) => {
      if (event.button !== 0 || event.altKey || !(event.target instanceof Element)
        || event.target.closest('button, input, textarea, select, a, [role="menu"]')) return
      const scroll = scrollerRef.current
      const list = root.querySelector<HTMLElement>('.ui-image-grid-list')
      const cell = list?.querySelector<HTMLElement>(':scope > [data-index]')
      if (!scroll || !list || !cell) return
      const view = scroll.getBoundingClientRect()
      if (event.clientX >= view.left + scroll.clientWidth || event.clientY >= view.top + scroll.clientHeight) return
      const rect = cell.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const style = getComputedStyle(list)
      const columnGap = parseFloat(style.columnGap) || 0, rowGap = parseFloat(style.rowGap) || 0
      const innerWidth = list.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
      const columns = Math.max(1, Math.round((innerWidth + columnGap) / (rect.width + columnGap)))
      const index = Number(cell.dataset.index)
      const client = { x: event.clientX, y: event.clientY }
      drag = {
        origin: point(client, scroll), client, initialClient: client, scroll, active: false,
        base: event.ctrlKey || event.metaKey || event.shiftKey ? new Set(latest.current.selected) : new Set(),
        result: new Set(),
        grid: {
          left: rect.left - view.left + scroll.scrollLeft - (index % columns) * (rect.width + columnGap),
          top: rect.top - view.top + scroll.scrollTop - Math.floor(index / columns) * (rect.height + rowGap),
          width: rect.width, height: rect.height, columns, columnGap, rowGap,
        },
      }
    }
    const move = (event: MouseEvent) => {
      if (!drag) return
      if (!(event.buttons & 1)) { finish(false); return }
      drag.client = { x: event.clientX, y: event.clientY }
      if (!drag.active && Math.hypot(event.clientX - drag.initialClient.x, event.clientY - drag.initialClient.y) >= 6) {
        drag.active = true
        frame = requestAnimationFrame(tick)
      }
      if (drag.active) { event.preventDefault(); update() }
    }
    const up = (event: MouseEvent) => { if (event.button === 0) finish(true) }
    const cancel = () => finish(false)
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') finish(false) }
    const click = (event: MouseEvent) => {
      if (suppressClick) { event.preventDefault(); event.stopPropagation() }
    }
    root.addEventListener('mousedown', down)
    root.addEventListener('click', click, true)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    window.addEventListener('blur', cancel)
    window.addEventListener('resize', cancel)
    window.addEventListener('keydown', key)
    return () => {
      cancel()
      window.clearTimeout(clickTimer)
      root.removeEventListener('mousedown', down)
      root.removeEventListener('click', click, true)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('resize', cancel)
      window.removeEventListener('keydown', key)
    }
  }, [rootRef, names, enabled])

  return { scrollerRef, preview, box }
}
