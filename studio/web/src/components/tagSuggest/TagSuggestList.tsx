/** Autocomplete 候选列表 — Portal + input-anchored fixed positioning。
 *
 * 浮层锚定输入框左下方，不跟随文本 caret 移动；空间不足时固定贴在输入框上方。
 * 输入框或视口几何变化时才重新测量，普通输入和候选更新不会改变位置。
 */
import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'

import type { TagSuggestion } from '../../tagDict/types'

const VIEWPORT_MARGIN = 8
const ANCHOR_GAP = 4
const MIN_POPOVER_WIDTH = 220
const MAX_POPOVER_HEIGHT = 260

interface Props {
  open: boolean
  pending: boolean
  suggestions: TagSuggestion[]
  activeIdx: number
  onPick: (s: TagSuggestion) => void
  onHover: (idx: number) => void
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>
  /** 可选 DOM id，供输入框 aria-controls 关联。 */
  id?: string
}

interface Position {
  left: number
  top?: number
  bottom?: number
  maxHeight: number
}

export function TagSuggestList({
  open, pending, suggestions, activeIdx, onPick, onHover, inputRef, id,
}: Props) {
  const [pos, setPos] = useState<Position | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const lastSuggestionsRef = useRef<readonly TagSuggestion[]>([])

  if (suggestions.length > 0) lastSuggestionsRef.current = suggestions
  else if (!pending) lastSuggestionsRef.current = []
  const displayedSuggestions = suggestions.length > 0
    ? suggestions
    : pending
      ? lastSuggestionsRef.current
      : []
  const hasDisplayedSuggestions = displayedSuggestions.length > 0

  useLayoutEffect(() => {
    if (!open || !inputRef.current || !hasDisplayedSuggestions) {
      setPos(null)
      return
    }
    const el = inputRef.current
    const updatePosition = () => {
      const rect = el.getBoundingClientRect()
      const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - ANCHOR_GAP - VIEWPORT_MARGIN)
      const spaceAbove = Math.max(0, rect.top - ANCHOR_GAP - VIEWPORT_MARGIN)
      const flipUp = spaceBelow < MAX_POPOVER_HEIGHT && spaceAbove > spaceBelow
      const availableHeight = flipUp ? spaceAbove : spaceBelow
      const maxLeft = Math.max(
        VIEWPORT_MARGIN,
        window.innerWidth - MIN_POPOVER_WIDTH - VIEWPORT_MARGIN,
      )
      const next: Position = {
        left: Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft)),
        maxHeight: Math.max(1, Math.min(MAX_POPOVER_HEIGHT, availableHeight)),
        ...(flipUp
          ? { bottom: window.innerHeight - rect.top + ANCHOR_GAP }
          : { top: rect.bottom + ANCHOR_GAP }),
      }
      setPos((current) => (
        current?.left === next.left
        && current.top === next.top
        && current.bottom === next.bottom
        && current.maxHeight === next.maxHeight
          ? current
          : next
      ))
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updatePosition)
    resizeObserver?.observe(el)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      resizeObserver?.disconnect()
    }
  }, [open, hasDisplayedSuggestions, inputRef])

  useLayoutEffect(() => {
    if (!open || pending) return
    const activeOption = listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (typeof activeOption?.scrollIntoView === 'function') {
      activeOption.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIdx, open, pending, suggestions])

  if (!open || !pos || !hasDisplayedSuggestions) return null

  return createPortal(
    <ul
      ref={listRef}
      id={id}
      className="bg-elevated border border-subtle rounded-sm shadow-lg max-h-[260px] overflow-y-auto min-w-[220px] list-none p-1 m-0"
      role="listbox"
      aria-busy={pending || undefined}
      style={{
        position: 'fixed',
        top: pos.top,
        bottom: pos.bottom,
        left: pos.left,
        maxHeight: pos.maxHeight,
        maxWidth: 'calc(100vw - 16px)',
        zIndex: 1000,
      }}
    >
      {displayedSuggestions.map((s, i) => (
        <li
          id={id ? `${id}-option-${i}` : undefined}
          key={s.tag}
          role="option"
          aria-selected={i === activeIdx}
          aria-disabled={pending || undefined}
          onMouseEnter={() => { if (!pending) onHover(i) }}
          // onMouseDown + preventDefault：input 不丢 focus
          onMouseDown={(e) => {
            e.preventDefault()
            if (!pending) onPick(s)
          }}
          className={
            'px-2.5 py-1 text-xs font-mono cursor-pointer rounded-sm flex items-center gap-2 ' +
            (i === activeIdx ? 'bg-overlay text-fg-primary' : 'text-fg-secondary hover:bg-overlay')
          }
        >
          <span>{s.tag}</span>
          {s.zh.length > 0 && (
            <span className="text-fg-tertiary truncate">{s.zh.join(' ')}</span>
          )}
        </li>
      ))}
    </ul>,
    document.body,
  )
}
