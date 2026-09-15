import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  type SortingStrategy,
} from '@dnd-kit/sortable'
import { useTranslation } from 'react-i18next'

import Button from './Button'
import { Input, Textarea } from './FormControl'
import ProjectCustomTags from './ProjectCustomTags'
import { SegmentedControl } from './SelectionGroup'
import { TranslatedTag } from './tagDisplay/TranslatedTag'
import { TagSuggestList } from './tagSuggest/TagSuggestList'
import { useTagSuggest } from './tagSuggest/useTagSuggest'

interface Props {
  tags: string[]
  /** Tags that stay visible in chip mode but are excluded from the saved value. */
  inactiveTags?: ReadonlySet<string>
  natural?: boolean
  onChange: (tags: string[], inactiveTags: ReadonlySet<string>) => void
  onSave?: () => void | Promise<void>
  saving?: boolean
  dirty?: boolean
  showTagCount?: boolean
  /** Identity of the edited source. Changing it resets only per-source buffers, not mode. */
  resetKey?: string
  customTags?: string[]
  customTagsBusy?: boolean
  onAddCustomTag?: (tag: string) => void | Promise<void>
  onDeleteCustomTag?: (tag: string) => void | Promise<void>
  onReplaceCustomTags?: (tags: string[]) => void | Promise<void>
}

type Mode = 'chip' | 'text'

const parseLine = (raw: string): string[] => {
  const next: string[] = []
  const seen = new Set<string>()
  for (const value of raw.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean)) {
    if (seen.has(value)) continue
    seen.add(value)
    next.push(value)
  }
  return next
}

const tagsEqual = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((tag, index) => tag === b[index])

const setsEqual = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && Array.from(a).every((tag) => b.has(tag))

const EMPTY_INACTIVE_TAGS: ReadonlySet<string> = new Set()

/**
 * Tags are variable-width items in a wrapping flex row. rectSortingStrategy
 * maps every displaced item into another item's rectangle, including scaleX /
 * scaleY. That distorts text and makes differently sized chips overlap.
 *
 * Keep the strategy itself transform-free. While dragging, the list remains
 * still and an insertion marker identifies the pending drop edge. Once the
 * parent accepts the new order, TagEditor runs a translation-only FLIP pass.
 */
export const tagFlowSortingStrategy: SortingStrategy = () => null

export type TagDropEdge = 'before' | 'after'

export type TagLayoutRect = Pick<DOMRect,
  'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>

export interface TagDropTarget {
  id: string
  edge: TagDropEdge
}

export const reorderTagFlow = (
  order: string[],
  activeId: string,
  overId: string,
  edge: TagDropEdge,
): string[] => {
  const oldIndex = order.indexOf(activeId)
  if (oldIndex < 0 || activeId === overId) return order

  const next = [...order]
  next.splice(oldIndex, 1)
  const overIndex = next.indexOf(overId)
  if (overIndex < 0) return order
  next.splice(overIndex + (edge === 'after' ? 1 : 0), 0, activeId)
  return tagsEqual(next, order) ? order : next
}

export const TAG_TONES = [
  '#768eca', // blue
  '#5da6ba', // cyan
  '#66af83', // green
  '#9b79ca', // purple
  '#bd79a1', // pink
] as const

const TAG_CHIP_CLASS =
  'relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] border px-2.5 py-1.5 select-none touch-none'

type TagToneStyle = React.CSSProperties & { '--tag-tone': string }

const tagToneStyle = (index: number): TagToneStyle => ({
  '--tag-tone': TAG_TONES[index % TAG_TONES.length],
  color: 'color-mix(in srgb, var(--tag-tone) 72%, var(--fg-primary))',
  backgroundColor: 'color-mix(in srgb, var(--tag-tone) 22%, var(--bg-surface))',
  borderColor: 'var(--tag-tone)',
})

const inactiveTagStyle: React.CSSProperties = {
  color: 'var(--tag-inactive-fg)',
  backgroundColor: 'var(--tag-inactive-bg)',
  borderColor: 'var(--tag-inactive-border)',
}

const tagChipStyle = (index: number, inactive: boolean): React.CSSProperties => (
  inactive ? inactiveTagStyle : tagToneStyle(index)
)

interface TagGeometry {
  id: string
  rect: TagLayoutRect
}

interface TagVisualRow {
  top: number
  bottom: number
  centerY: number
  items: TagGeometry[]
}

const rectCenterX = (rect: TagLayoutRect): number => rect.left + rect.width / 2
const rectCenterY = (rect: TagLayoutRect): number => rect.top + rect.height / 2

const buildTagVisualRows = (
  order: string[],
  rects: ReadonlyMap<string, TagLayoutRect>,
): TagVisualRow[] => {
  const geometries = order.map((id) => {
    const rect = rects.get(id)
    return rect ? { id, rect } : null
  })
  if (geometries.some((item) => item === null)) return []

  const rows: TagVisualRow[] = []
  for (const geometry of (geometries as TagGeometry[]).sort((a, b) => (
    a.rect.top - b.rect.top || a.rect.left - b.rect.left
  ))) {
    const row = rows.find((candidate) => (
      Math.min(candidate.bottom, geometry.rect.bottom)
        > Math.max(candidate.top, geometry.rect.top)
    ))
    if (row) {
      row.items.push(geometry)
      row.top = Math.min(row.top, geometry.rect.top)
      row.bottom = Math.max(row.bottom, geometry.rect.bottom)
      row.centerY = (row.top + row.bottom) / 2
    } else {
      rows.push({
        top: geometry.rect.top,
        bottom: geometry.rect.bottom,
        centerY: rectCenterY(geometry.rect),
        items: [geometry],
      })
    }
  }
  rows.sort((a, b) => a.top - b.top)
  rows.forEach((row) => row.items.sort((a, b) => a.rect.left - b.rect.left))
  return rows
}

/**
 * Resolve a wrapped tag flow using the dragged chip's centre, not the pointer.
 * A horizontal insertion changes only after crossing another chip's centre;
 * another visual row becomes eligible only after crossing that row's centre.
 */
export const resolveTagCenterDrop = (
  order: string[],
  activeId: string,
  draggedRect: TagLayoutRect,
  listRect: TagLayoutRect,
  rects: ReadonlyMap<string, TagLayoutRect>,
): TagDropTarget | null => {
  if (order.length < 2 || !order.includes(activeId)) return null
  const centerX = rectCenterX(draggedRect)
  const centerY = rectCenterY(draggedRect)
  if (centerX < listRect.left || centerX > listRect.right
    || centerY < listRect.top || centerY > listRect.bottom) return null

  const rows = buildTagVisualRows(order, rects)
  const originRowIndex = rows.findIndex((row) => row.items.some(({ id }) => id === activeId))
  const activeRect = rects.get(activeId)
  if (originRowIndex < 0 || !activeRect) return null

  let targetRowIndex = originRowIndex
  const originCenterY = rectCenterY(activeRect)
  if (centerY > originCenterY) {
    for (let index = originRowIndex + 1; index < rows.length; index += 1) {
      if (centerY <= rows[index].centerY) break
      targetRowIndex = index
    }
  } else if (centerY < originCenterY) {
    for (let index = originRowIndex - 1; index >= 0; index -= 1) {
      if (centerY >= rows[index].centerY) break
      targetRowIndex = index
    }
  }

  const targetItems = rows[targetRowIndex].items.filter(({ id }) => id !== activeId)
  if (targetItems.length === 0) return null
  const itemsBeforeRow = rows.slice(0, targetRowIndex).reduce((count, row) => (
    count + row.items.filter(({ id }) => id !== activeId).length
  ), 0)
  const itemsBeforeCenter = targetItems.filter(({ rect }) => rectCenterX(rect) < centerX).length
  const insertionIndex = itemsBeforeRow + itemsBeforeCenter
  const remaining = order.filter((id) => id !== activeId)
  const next = [...remaining]
  next.splice(insertionIndex, 0, activeId)
  if (tagsEqual(next, order)) return null

  return insertionIndex < remaining.length
    ? { id: remaining[insertionIndex], edge: 'before' }
    : { id: remaining[remaining.length - 1], edge: 'after' }
}

const translateRect = (
  rect: TagLayoutRect,
  delta: { x: number; y: number },
): TagLayoutRect => ({
  left: rect.left + delta.x,
  right: rect.right + delta.x,
  top: rect.top + delta.y,
  bottom: rect.bottom + delta.y,
  width: rect.width,
  height: rect.height,
})

interface PendingFlip {
  order: string[]
  rects: Map<string, DOMRect>
}

export default function TagEditor({
  tags,
  inactiveTags = EMPTY_INACTIVE_TAGS,
  natural,
  onChange,
  onSave,
  saving,
  dirty,
  showTagCount = true,
  resetKey,
  customTags = [],
  customTagsBusy = false,
  onAddCustomTag,
  onDeleteCustomTag,
  onReplaceCustomTags,
}: Props) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const selectedTags = useMemo(
    () => tags.filter((tag) => !inactiveTags.has(tag)),
    [inactiveTags, tags],
  )
  const tagsJoined = useMemo(() => selectedTags.join(', '), [selectedTags])
  const [mode, setMode] = useState<Mode>(natural ? 'text' : 'chip')
  const [textBuf, setTextBuf] = useState(() => tagsJoined)
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<TagDropTarget | null>(null)
  const dropTargetRef = useRef<TagDropTarget | null>(null)
  const chipListRef = useRef<HTMLDivElement>(null)
  const chipNodesRef = useRef(new Map<string, HTMLButtonElement>())
  const pendingFlipRef = useRef<PendingFlip | null>(null)
  const flipAnimationsRef = useRef<Animation[]>([])
  const textTagsRef = useRef([...selectedTags])
  const previousResetKeyRef = useRef(resetKey)
  const draftInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const suppressChipClickRef = useRef(false)
  const suppressChipClickTimerRef = useRef<number | null>(null)

  // PointerSensor + 6px 启动距离：轻微点击仍是点选，越过阈值才进入排序。
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  const setPendingDrop = (next: TagDropTarget | null) => {
    dropTargetRef.current = next
    setDropTarget((current) => (
      current?.id === next?.id && current?.edge === next?.edge ? current : next
    ))
  }

  const cancelFlipAnimations = () => {
    flipAnimationsRef.current.forEach((animation) => animation.cancel())
    flipAnimationsRef.current = []
  }

  useEffect(() => () => {
    cancelFlipAnimations()
    if (suppressChipClickTimerRef.current != null) {
      window.clearTimeout(suppressChipClickTimerRef.current)
    }
  }, [])

  useLayoutEffect(() => {
    const pending = pendingFlipRef.current
    if (!pending || !tagsEqual(tags, pending.order)) return
    pendingFlipRef.current = null
    cancelFlipAnimations()

    const reduceMotion = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) return

    const animations: Animation[] = []
    chipNodesRef.current.forEach((node, tag) => {
      const before = pending.rects.get(tag)
      if (!before || typeof node.animate !== 'function') return
      const after = node.getBoundingClientRect()
      const dx = before.left - after.left
      const dy = before.top - after.top
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
      animations.push(node.animate(
        [
          { transform: `translate3d(${dx}px, ${dy}px, 0)` },
          { transform: 'translate3d(0, 0, 0)' },
        ],
        { duration: 160, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
      ))
    })
    flipAnimationsRef.current = animations
  }, [tags])

  // Reset draft when image switches
  useEffect(() => { setDraft('') }, [tags])

  // Source identity is separate from its value: two images may legitimately share
  // identical tags. Switching images resets per-image buffers without resetting mode.
  useEffect(() => {
    if (previousResetKeyRef.current === resetKey) return
    previousResetKeyRef.current = resetKey
    setDraft('')
    setTextBuf(tagsJoined)
    textTagsRef.current = [...selectedTags]
    pendingFlipRef.current = null
    setActiveTag(null)
    setPendingDrop(null)
  }, [resetKey, selectedTags, tagsJoined])

  // Keep free-form punctuation and spacing intact while the parent echoes edits back.
  // A genuinely external tag change (for example, another active image) resets the buffer.
  useEffect(() => {
    if (mode !== 'text') {
      textTagsRef.current = [...selectedTags]
      return
    }
    if (tagsEqual(selectedTags, textTagsRef.current)) return
    setTextBuf(tagsJoined)
    textTagsRef.current = [...selectedTags]
  }, [mode, selectedTags, tagsJoined])

  const addTag = (raw: string) => {
    const t = raw.trim().replace(/^[,，]+|[,，]+$/g, '')
    if (!t) return
    if (tags.includes(t)) {
      if (inactiveTags.has(t)) {
        const nextInactive = new Set(inactiveTags)
        nextInactive.delete(t)
        onChange(tags, nextInactive)
      }
      setDraft('')
      return
    }
    // 加到末尾：跟 chip 拖拽重排的心智一致（新东西落在底部，用户拖到想要的位置）
    onChange([...tags, t], inactiveTags)
    setDraft('')
  }

  // chip 模式 input：draft 整体当一个 token；选中候选直接 addTag。
  const draftSuggest = useTagSuggest({
    value: draft,
    inputRef: draftInputRef,
    wholeAsToken: true,
    onPick: ({ suggestion }) => { addTag(suggestion.tag) },
  })

  const updateText = (raw: string) => {
    setTextBuf(raw)
    const nextSelected = parseLine(raw)
    const selectedSet = new Set(nextSelected)
    const nextTags = [
      ...nextSelected,
      ...tags.filter((tag) => !selectedSet.has(tag)),
    ]
    const nextInactive = new Set(nextTags.filter((tag) => !selectedSet.has(tag)))
    textTagsRef.current = nextSelected
    if (!tagsEqual(nextTags, tags) || !setsEqual(nextInactive, inactiveTags)) {
      onChange(nextTags, nextInactive)
    }
  }

  // text 模式 textarea：根据 cursor 算 token range，替换为 `tag, ` 并保持光标。
  const textSuggest = useTagSuggest({
    value: textBuf,
    inputRef: textareaRef,
    onPick: ({ suggestion, range }) => {
      const before = textBuf.slice(0, range.start)
      const after = textBuf.slice(range.end)
      const cleanAfter = after.replace(/^[,，]\s*/, '')
      const next = `${before}${suggestion.tag}, ${cleanAfter}`
      updateText(next)
      const newCursor = before.length + suggestion.tag.length + 2
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (el) { el.focus(); el.setSelectionRange(newCursor, newCursor) }
      })
    },
  })

  const toggleTag = (tag: string) => {
    const nextInactive = new Set(inactiveTags)
    if (nextInactive.has(tag)) nextInactive.delete(tag)
    else nextInactive.add(tag)
    onChange(tags, nextInactive)
  }

  const armPostDragClickGuard = () => {
    suppressChipClickRef.current = true
    if (suppressChipClickTimerRef.current != null) {
      window.clearTimeout(suppressChipClickTimerRef.current)
    }
    suppressChipClickTimerRef.current = window.setTimeout(() => {
      suppressChipClickRef.current = false
      suppressChipClickTimerRef.current = null
    }, 0)
  }

  const handleDragStart = (event: DragStartEvent) => {
    cancelFlipAnimations()
    suppressChipClickRef.current = true
    setPendingDrop(null)
    setActiveTag(String(event.active.id))
  }

  const handleDragMove = (event: DragMoveEvent) => {
    const activeId = String(event.active.id)
    const listRect = chipListRef.current?.getBoundingClientRect()
    if (!listRect) {
      setPendingDrop(null)
      return
    }
    const rects = new Map<string, TagLayoutRect>()
    for (const tag of tags) {
      const node = chipNodesRef.current.get(tag)
      if (!node) {
        setPendingDrop(null)
        return
      }
      rects.set(tag, node.getBoundingClientRect())
    }
    const measuredInitialRect = event.active.rect.current.initial
    const initialRect = measuredInitialRect?.width && measuredInitialRect.height
      ? measuredInitialRect
      : rects.get(activeId)
    // delta is scroll-adjusted and belongs to this exact move event, while the
    // translated ref may still describe the previous render for one frame.
    const draggedRect = initialRect
      ? translateRect(initialRect, event.delta)
      : event.active.rect.current.translated
    setPendingDrop(draggedRect
      ? resolveTagCenterDrop(tags, activeId, draggedRect, listRect, rects)
      : null)
  }

  const clearDragState = () => {
    setActiveTag(null)
    setPendingDrop(null)
  }

  const cancelDrag = () => {
    armPostDragClickGuard()
    clearDragState()
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const target = dropTargetRef.current
    const next = target
      ? reorderTagFlow(tags, String(event.active.id), target.id, target.edge)
      : tags
    if (next !== tags) {
      pendingFlipRef.current = {
        order: next,
        rects: new Map(Array.from(chipNodesRef.current, ([tag, node]) => (
          [tag, node.getBoundingClientRect()]
        ))),
      }
    }
    armPostDragClickGuard()
    clearDragState()
    if (next === tags) return
    onChange(next, inactiveTags)
  }

  const registerChipNode = useCallback((tag: string, node: HTMLButtonElement | null) => {
    if (node) chipNodesRef.current.set(tag, node)
    else chipNodesRef.current.delete(tag)
  }, [])

  const switchToText = () => {
    if (mode === 'text') return
    setTextBuf(tagsJoined)
    textTagsRef.current = [...selectedTags]
    setMode('text')
  }

  const switchToChip = () => {
    if (mode === 'chip') return
    setMode('chip')
  }

  const customTagPalette = onAddCustomTag && onDeleteCustomTag && onReplaceCustomTags ? (
    <ProjectCustomTags
      tags={customTags}
      activeTags={new Set(selectedTags)}
      busy={customTagsBusy}
      resetKey={resetKey}
      onPick={addTag}
      onAdd={onAddCustomTag}
      onDelete={onDeleteCustomTag}
      onReplace={onReplaceCustomTags}
    />
  ) : null

  if (natural) {
    return (
      <div className="flex flex-col gap-2 flex-1 min-h-0">
        <Textarea
          value={tags[0] ?? ''}
          onChange={(e) => onChange([e.target.value], EMPTY_INACTIVE_TAGS)}
          placeholder={t('tagEditor.naturalPlaceholder')}
          aria-label={t('tagEditor.naturalInputLabel')}
          mono
          className="text-sm flex-1 resize-none"
        />
        {onSave && (
          <Button
            variant={dirty ? 'primary' : 'secondary'}
            size="sm"
            disabled={saving || !dirty}
            loading={saving}
            onClick={onSave}
            className="self-start"
          >
            {saving ? t('common.saving') : dirty ? t('common.save') : t('saveBar.saved')}
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5 flex-1 min-h-0">
      {/* mode switch */}
      <div className="flex items-center gap-related text-xs shrink-0">
        <SegmentedControl
          items={[
            { value: 'chip', label: t('tagEditor.modeChip') },
            { value: 'text', label: t('tagEditor.modeText') },
          ]}
          value={mode}
          onChange={(next) => next === 'chip' ? switchToChip() : switchToText()}
          ariaLabel={t('tagEditor.modeLabel')}
          idPrefix="tag-editor-mode"
          size="sm"
          layout="content"
        />
        <span className="flex-1" />
        {showTagCount && (
          <span className="text-fg-tertiary tnum">
            {t('tagEditor.tagCount', { n: selectedTags.length })}
          </span>
        )}
      </div>

      {/* content area — both modes use flex:1 so no height jitter */}
      {mode === 'chip' ? (
        <>
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onDragCancel={cancelDrag}
          >
            <SortableContext items={tags} strategy={tagFlowSortingStrategy}>
              <div
                ref={chipListRef}
                data-tag-chip-list
                className="flex flex-wrap gap-2 overflow-y-auto flex-1 min-h-0 content-start py-1"
              >
                {tags.length === 0 && (
                  <span className="text-xs text-fg-tertiary">{t('tagEditor.empty')}</span>
                )}
                {tags.map((t, index) => (
                  <SortableChip
                    key={t}
                    id={t}
                    toneIndex={index}
                    inactive={inactiveTags.has(t)}
                    insertionEdge={dropTarget?.id === t ? dropTarget.edge : null}
                    onNodeChange={registerChipNode}
                    onToggle={() => toggleTag(t)}
                    suppressClickRef={suppressChipClickRef}
                  />
                ))}
                <div className="basis-full flex items-center gap-1.5 shrink-0">
                  <div className="relative flex-1">
                    <Input
                      ref={draftInputRef}
                      value={draft}
                      onChange={(e) => { setDraft(e.target.value); draftSuggest.notifyChange() }}
                      onKeyDown={(e) => {
                        if (draftSuggest.handleKeyDown(e)) return
                        if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
                          e.preventDefault(); addTag(draft)
                        }
                      }}
                      onClick={() => draftSuggest.notifyClick()}
                      onFocus={() => draftSuggest.notifyFocus()}
                      onBlur={() => draftSuggest.notifyBlur()}
                      placeholder={t('tagEditor.addPlaceholder')}
                      aria-label={t('tagEditor.addInputLabel')}
                      controlSize="sm"
                      mono
                      className="w-full"
                    />
                    <TagSuggestList
                      open={draftSuggest.open}
                      suggestions={draftSuggest.suggestions}
                      activeIdx={draftSuggest.activeIdx}
                      onPick={(s) => draftSuggest.pickAt(draftSuggest.suggestions.indexOf(s))}
                      onHover={draftSuggest.setActiveIdx}
                      inputRef={draftInputRef}
                      cursor={draftSuggest.cursor}
                      positionDeps={[draft]}
                    />
                  </div>
                  {onSave && (
                    <Button
                      variant={dirty ? 'primary' : 'secondary'}
                      size="sm"
                      disabled={saving || !dirty}
                      loading={saving}
                      onClick={onSave}
                    >
                      {saving ? t('common.saving') : dirty ? t('common.save') : t('saveBar.saved')}
                    </Button>
                  )}
                </div>
              </div>
            </SortableContext>
            <DragOverlay adjustScale={false} dropAnimation={null}>
              {activeTag ? (
                <span
                  aria-hidden="true"
                  className={`${TAG_CHIP_CLASS} shadow-lg cursor-grabbing pointer-events-none`}
                  style={tagChipStyle(
                    Math.max(0, tags.indexOf(activeTag)),
                    inactiveTags.has(activeTag),
                  )}
                >
                  <TranslatedTag
                    tag={activeTag}
                    layout="stacked"
                    missingTranslation="-"
                    translationClassName="text-current opacity-70"
                  />
                </span>
              ) : null}
            </DragOverlay>
          </DndContext>
          {customTagPalette}
        </>
      ) : (
        <>
          <div className="relative flex-1 min-h-0 flex flex-col">
            <Textarea
              ref={textareaRef}
              value={textBuf}
              onChange={(e) => { updateText(e.target.value); textSuggest.notifyChange() }}
              onKeyDown={(e) => { textSuggest.handleKeyDown(e) }}
              onKeyUp={() => textSuggest.notifySelect()}
              onClick={() => textSuggest.notifyClick()}
              onFocus={() => textSuggest.notifyFocus()}
              onBlur={() => { textSuggest.notifyBlur() }}
              placeholder={t('tagEditor.textPlaceholder')}
              aria-label={t('tagEditor.textInputLabel')}
              controlSize="sm"
              mono
              className="flex-1 resize-none"
            />
            <TagSuggestList
              open={textSuggest.open}
              suggestions={textSuggest.suggestions}
              activeIdx={textSuggest.activeIdx}
              onPick={(s) => textSuggest.pickAt(textSuggest.suggestions.indexOf(s))}
              onHover={textSuggest.setActiveIdx}
              inputRef={textareaRef}
              cursor={textSuggest.cursor}
              positionDeps={[textBuf]}
            />
          </div>
          {customTagPalette}
          {onSave && (
            <div className="flex items-center justify-end shrink-0">
              <Button
                variant={dirty ? 'primary' : 'secondary'}
                size="sm"
                disabled={saving || !dirty}
                loading={saving}
                onClick={onSave}
              >
                {saving ? t('common.saving') : dirty ? t('common.save') : t('saveBar.saved')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** 可点选、可拖拽的单个 chip。 */
function SortableChip({
  id,
  toneIndex,
  inactive,
  insertionEdge,
  onNodeChange,
  onToggle,
  suppressClickRef,
}: {
  id: string
  toneIndex: number
  inactive: boolean
  insertionEdge: TagDropEdge | null
  onNodeChange: (tag: string, node: HTMLButtonElement | null) => void
  onToggle: () => void
  suppressClickRef: React.MutableRefObject<boolean>
}) {
  const {
    attributes, listeners, setNodeRef, isDragging,
  } = useSortable({ id })
  const ref = useCallback((node: HTMLButtonElement | null) => {
    setNodeRef(node)
    onNodeChange(id, node)
  }, [id, onNodeChange, setNodeRef])
  return (
    <button
      type="button"
      ref={ref}
      style={tagChipStyle(toneIndex, inactive)}
      data-tag-chip={id}
      data-tag-tone-index={toneIndex % TAG_TONES.length}
      data-tag-inactive={inactive ? 'true' : 'false'}
      {...attributes}
      {...listeners}
      aria-pressed={!inactive}
      onClick={(event) => {
        if (suppressClickRef.current) {
          event.preventDefault()
          return
        }
        onToggle()
      }}
      className={`${TAG_CHIP_CLASS} appearance-none font-[inherit] text-left cursor-grab active:cursor-grabbing transition-[color,background-color,border-color,box-shadow,opacity] ${
        isDragging ? 'opacity-25' : 'opacity-100'
      }`}
    >
      {insertionEdge && (
        <span
          aria-hidden="true"
          data-tag-insertion-edge={insertionEdge}
          className={`pointer-events-none absolute -inset-y-0.5 z-10 w-1 rounded-full bg-info shadow-sm ${
            insertionEdge === 'before' ? '-left-[6px]' : '-right-[6px]'
          }`}
        />
      )}
      <TranslatedTag
        tag={id}
        layout="stacked"
        missingTranslation="-"
        translationClassName="text-current opacity-70"
      />
    </button>
  )
}
