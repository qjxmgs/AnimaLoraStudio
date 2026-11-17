/** Autocomplete 候选列表 — Portal + input-anchored fixed positioning。
 *
 * 浮层锚定输入框左下方，不跟随文本 caret 移动；空间不足时固定贴在输入框上方。
 * 输入框或视口几何变化时才重新测量，普通输入和候选更新不会改变位置。
 */
import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'

import { useTranslation } from 'react-i18next'
import { useTagDict } from '../../tagDict/store'
import { extractWhitespaceToken } from '../../tagDict/suggest'
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
  compactStacked?: boolean
}

interface Position {
  left: number
  top?: number
  bottom?: number
  maxHeight: number
}

export function TagSuggestList({
  open, pending, suggestions, activeIdx, onPick, onHover, inputRef, id, compactStacked = true,
}: Props) {
  const { t } = useTranslation()
  const dict = useTagDict()
  const query = compactStacked && inputRef.current
    ? extractWhitespaceToken(inputRef.current.value, inputRef.current.selectionStart ?? inputRef.current.value.length).token : ''
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
        maxHeight: Math.max(1, availableHeight),
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
      className="bg-elevated border border-subtle shadow-lg overflow-y-auto list-none p-1 m-0"
      role="listbox"
      aria-busy={pending || undefined}
      style={{
        position: 'fixed',
        top: pos.top,
        bottom: pos.bottom,
        left: pos.left,
        maxHeight: pos.maxHeight,
        height: pos.maxHeight,
        borderRadius: 10,
        maxWidth: `calc(100vw - ${pos.left + VIEWPORT_MARGIN}px)`,
        ...(compactStacked ? { width: 'max-content', minWidth: 0, right: 'auto' } : {}),
        zIndex: 1000,
      }}
    >
      {displayedSuggestions.map((s, i) => (
        <li
          id={id ? `${id}-option-${i}` : undefined}
          key={s.tag}
          role="option"
          aria-label={`${s.tag} ${s.zh.join(" ")}`}
          aria-selected={i === activeIdx}
          aria-disabled={pending || undefined}
          onMouseEnter={() => { if (!pending) onHover(i) }}
          // onMouseDown + preventDefault：input 不丢 focus
          onMouseDown={(e) => {
            e.preventDefault()
            if (!pending) onPick(s)
          }}
          className={
            'px-2.5 py-1 font-mono cursor-pointer rounded-sm flex ' +
            (compactStacked ? 'items-start justify-between gap-5 text-sm ' : 'items-center gap-2 text-xs ') +
            (i === activeIdx ? 'bg-overlay text-fg-primary' : 'text-fg-secondary hover:bg-overlay')
          }
        >
          <span style={{ minWidth: 0, maxWidth: '100%' }}>
            <span style={compactStacked ? { display: 'block', overflowWrap: 'anywhere', fontWeight: 600,
              color: categoryStyle(dict.categories?.get(s.tag)).color } : undefined}>
              {compactStacked ? highlightMatch(s.tag, s.query ?? query) : s.tag}
            </span>
            {s.zh.length > 0 && <span className={compactStacked ? "text-xs font-sans" : "text-fg-tertiary truncate"}
              style={compactStacked ? { display: 'block', marginTop: 2, color: '#8b929e', overflowWrap: 'anywhere' } : undefined}>
              {compactStacked ? highlightMatch(s.zh.join(' '), s.query ?? query) : s.zh.join(' ')}
            </span>}
          </span>
          {compactStacked && <span className="text-xs font-sans" style={{ color: categoryStyle(dict.categories?.get(s.tag)).color, whiteSpace: 'nowrap', alignSelf: 'center' }}>
            ● {t(`download.tagCategory.${categoryStyle(dict.categories?.get(s.tag)).key}`, { defaultValue: '常规' })}
          </span>}

        </li>
      ))}
    </ul>,
    document.body,
  )
}

function categoryStyle(category?: number) {
  switch (category) {
    case 0: return { color: '#589bea', key: 'regular' }
    case 1: return { color: '#e6818c', key: 'artist' }
    case 3: return { color: '#b68ae5', key: 'copyright' }
    case 4: return { color: '#58b989', key: 'character' }
    case 5: return { color: '#d59d49', key: 'meta' }
    default: return { color: '#589bea', key: 'regular' }
  }
}

/** Match compact English tokens while preserving the displayed spacing. */
function highlightMatch(text: string, query: string) {
  const needle = query.toLowerCase().replace(/[\s_]/g, '')
  if (!needle) return text
  const indices: number[] = []
  let normalized = ''
  for (let i = 0; i < text.length; i++) {
    if (!/[\s_]/.test(text[i])) { normalized += text[i].toLowerCase(); indices.push(i) }
  }
  const matched = new Set<number>()
  let start = normalized.indexOf(needle)
  if (start >= 0) {
    while (start >= 0) {
      for (let j = start; j < start + needle.length; j++) matched.add(indices[j])
      start = normalized.indexOf(needle, start + needle.length)
    }
  } else {
    let j = 0
    for (let i = 0; i < normalized.length && j < needle.length; i++) {
      if (normalized[i] === needle[j]) { matched.add(indices[i]); j++ }
    }
    if (j !== needle.length) return text
  }
  return Array.from(text).map((char, i) => matched.has(i)
    ? <span key={i} style={{ color: '#ef4444', fontWeight: 700 }}>{char}</span> : char)
}
