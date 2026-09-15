import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
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
import { SegmentedControl } from './SelectionGroup'
import { TranslatedTag } from './tagDisplay/TranslatedTag'
import { TagSuggestList } from './tagSuggest/TagSuggestList'
import { useTagSuggest } from './tagSuggest/useTagSuggest'

interface Props {
  tags: string[]
  natural?: boolean
  onChange: (tags: string[]) => void
  onSave?: () => void | Promise<void>
  saving?: boolean
  dirty?: boolean
  showTagCount?: boolean
  /** Identity of the edited source. Changing it resets only per-source buffers, not mode. */
  resetKey?: string
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

export const getTagDropEdge = (
  pointerX: number,
  targetLeft: number,
  targetWidth: number,
): TagDropEdge => pointerX < targetLeft + targetWidth / 2 ? 'before' : 'after'

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

interface DropTarget {
  id: string
  edge: TagDropEdge
}

interface PendingFlip {
  order: string[]
  rects: Map<string, DOMRect>
}

export default function TagEditor({
  tags, natural, onChange, onSave, saving, dirty, showTagCount = true, resetKey,
}: Props) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const tagsJoined = useMemo(() => tags.join(', '), [tags])
  const [mode, setMode] = useState<Mode>(natural ? 'text' : 'chip')
  const [textBuf, setTextBuf] = useState(() => tagsJoined)
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const dropTargetRef = useRef<DropTarget | null>(null)
  const pointerCoordinatesRef = useRef<{ x: number; y: number } | null>(null)
  const chipListRef = useRef<HTMLDivElement>(null)
  const chipNodesRef = useRef(new Map<string, HTMLSpanElement>())
  const pendingFlipRef = useRef<PendingFlip | null>(null)
  const flipAnimationsRef = useRef<Animation[]>([])
  const textTagsRef = useRef([...tags])
  const previousResetKeyRef = useRef(resetKey)
  const draftInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // PointerSensor + 6px 启动距离：拖拽手感不会跟「点 × 删除」/ 误触冲突。
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const pointer = args.pointerCoordinates
    pointerCoordinatesRef.current = pointer
    const listRect = chipListRef.current?.getBoundingClientRect()
    if (!pointer || !listRect
      || pointer.x < listRect.left || pointer.x > listRect.right
      || pointer.y < listRect.top || pointer.y > listRect.bottom) {
      return []
    }

    // The original chip stays in place as a placeholder and must not become a
    // drop target. In a flex gap, fall back to the nearest neighbouring chip.
    const filteredArgs = {
      ...args,
      droppableContainers: args.droppableContainers.filter(({ id }) => id !== args.active.id),
    }
    const direct = pointerWithin(filteredArgs)
    return direct.length > 0 ? direct : closestCenter(filteredArgs)
  }, [])

  const setPendingDrop = (next: DropTarget | null) => {
    dropTargetRef.current = next
    setDropTarget((current) => (
      current?.id === next?.id && current?.edge === next?.edge ? current : next
    ))
  }

  const cancelFlipAnimations = () => {
    flipAnimationsRef.current.forEach((animation) => animation.cancel())
    flipAnimationsRef.current = []
  }

  useEffect(() => () => cancelFlipAnimations(), [])

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
    textTagsRef.current = [...tags]
    pendingFlipRef.current = null
    setActiveTag(null)
    setPendingDrop(null)
  }, [resetKey, tags, tagsJoined])

  // Keep free-form punctuation and spacing intact while the parent echoes edits back.
  // A genuinely external tag change (for example, another active image) resets the buffer.
  useEffect(() => {
    if (mode !== 'text') {
      textTagsRef.current = [...tags]
      return
    }
    if (tagsEqual(tags, textTagsRef.current)) return
    setTextBuf(tagsJoined)
    textTagsRef.current = [...tags]
  }, [mode, tags, tagsJoined])

  const addTag = (raw: string) => {
    const t = raw.trim().replace(/^[,，]+|[,，]+$/g, '')
    if (!t) return
    if (tags.includes(t)) { setDraft(''); return }
    // 加到末尾：跟 chip 拖拽重排的心智一致（新东西落在底部，用户拖到想要的位置）
    onChange([...tags, t])
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
    const next = parseLine(raw)
    textTagsRef.current = next
    if (!tagsEqual(next, tags)) onChange(next)
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

  const removeTag = (t: string) => {
    onChange(tags.filter((x) => x !== t))
  }

  const handleDragStart = (event: DragStartEvent) => {
    cancelFlipAnimations()
    setPendingDrop(null)
    setActiveTag(String(event.active.id))
  }

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event
    const pointer = pointerCoordinatesRef.current
    if (!over || !pointer || active.id === over.id) {
      setPendingDrop(null)
      return
    }
    const edge = getTagDropEdge(pointer.x, over.rect.left, over.rect.width)
    const next: DropTarget = { id: String(over.id), edge }
    // Do not advertise the gap that would leave the order unchanged.
    setPendingDrop(reorderTagFlow(tags, String(active.id), next.id, edge) === tags ? null : next)
  }

  const clearDragState = () => {
    setActiveTag(null)
    setPendingDrop(null)
    pointerCoordinatesRef.current = null
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const target = event.over ? dropTargetRef.current : null
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
    clearDragState()
    if (next === tags) return
    onChange(next)
  }

  const registerChipNode = useCallback((tag: string, node: HTMLSpanElement | null) => {
    if (node) chipNodesRef.current.set(tag, node)
    else chipNodesRef.current.delete(tag)
  }, [])

  const switchToText = () => {
    if (mode === 'text') return
    setTextBuf(tagsJoined)
    textTagsRef.current = [...tags]
    setMode('text')
  }

  const switchToChip = () => {
    if (mode === 'chip') return
    setMode('chip')
  }

  if (natural) {
    return (
      <div className="flex flex-col gap-2 flex-1 min-h-0">
        <Textarea
          value={tags[0] ?? ''}
          onChange={(e) => onChange([e.target.value])}
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
          <span className="text-fg-tertiary tnum">{t('tagEditor.tagCount', { n: tags.length })}</span>
        )}
      </div>

      {/* content area — both modes use flex:1 so no height jitter */}
      {mode === 'chip' ? (
        <>
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            onDragStart={handleDragStart}
            onDragMove={handleDragOver}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={clearDragState}
          >
            <SortableContext items={tags} strategy={tagFlowSortingStrategy}>
              <div ref={chipListRef} className="flex flex-wrap gap-2 overflow-y-auto flex-1 min-h-0 content-start py-1">
                {tags.length === 0 && (
                  <span className="text-xs text-fg-tertiary">{t('tagEditor.empty')}</span>
                )}
                {tags.map((t, index) => (
                  <SortableChip
                    key={t}
                    id={t}
                    toneIndex={index}
                    insertionEdge={dropTarget?.id === t ? dropTarget.edge : null}
                    onNodeChange={registerChipNode}
                    onRemove={() => removeTag(t)}
                  />
                ))}
              </div>
            </SortableContext>
            <DragOverlay adjustScale={false} dropAnimation={null}>
              {activeTag ? (
                <span
                  aria-hidden="true"
                  className={`${TAG_CHIP_CLASS} shadow-lg cursor-grabbing pointer-events-none`}
                  style={tagToneStyle(Math.max(0, tags.indexOf(activeTag)))}
                >
                  <TranslatedTag
                    tag={activeTag}
                    layout="stacked"
                    missingTranslation="-"
                    translationClassName="text-current opacity-70"
                  />
                  <span className="text-fg-tertiary text-sm leading-none">×</span>
                </span>
              ) : null}
            </DragOverlay>
          </DndContext>
          <div className="flex items-center gap-1.5 shrink-0">
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

/** 单个可拖拽 chip。
 *
 * × 删除按钮要 stopPropagation onPointerDown —— 否则 6px 移动阈值过后 × 也成了
 * 拖拽起点,点 × 反而触发拖拽。
 */
function SortableChip({
  id,
  toneIndex,
  insertionEdge,
  onNodeChange,
  onRemove,
}: {
  id: string
  toneIndex: number
  insertionEdge: TagDropEdge | null
  onNodeChange: (tag: string, node: HTMLSpanElement | null) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const {
    attributes, listeners, setNodeRef, isDragging,
  } = useSortable({ id })
  const ref = useCallback((node: HTMLSpanElement | null) => {
    setNodeRef(node)
    onNodeChange(id, node)
  }, [id, onNodeChange, setNodeRef])
  return (
    <span
      ref={ref}
      style={tagToneStyle(toneIndex)}
      data-tag-chip={id}
      data-tag-tone-index={toneIndex % TAG_TONES.length}
      {...attributes}
      {...listeners}
      className={`${TAG_CHIP_CLASS} cursor-grab active:cursor-grabbing transition-[background-color,border-color,box-shadow,opacity] ${
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
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onRemove}
        aria-label={t('tagEditor.deleteTag', { tag: id })}
        className="self-stretch flex items-center bg-transparent border-none text-fg-tertiary hover:text-err cursor-pointer p-0 pl-0.5 text-sm leading-none"
      >
        ×
      </button>
    </span>
  )
}
