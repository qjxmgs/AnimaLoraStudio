import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  type SortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
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
 * Keep the strategy itself transform-free. The DOM order is updated on
 * DragOver, so useSortable can animate each same-sized chip from its previous
 * layout position to its new one. SortableChip applies translation only and
 * deliberately drops any scale component.
 */
export const tagFlowSortingStrategy: SortingStrategy = () => null

export const reorderTagFlow = (order: string[], activeId: string, overId: string): string[] => {
  const oldIndex = order.indexOf(activeId)
  const newIndex = order.indexOf(overId)
  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return order
  return arrayMove(order, oldIndex, newIndex)
}

const TAG_CHIP_CLASS =
  'inline-flex shrink-0 items-center gap-1 whitespace-nowrap px-2 py-0.5 rounded-full bg-overlay border border-subtle text-sm font-mono text-fg-primary select-none touch-none'

export default function TagEditor({
  tags, natural, onChange, onSave, saving, dirty, showTagCount = true, resetKey,
}: Props) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const tagsJoined = useMemo(() => tags.join(', '), [tags])
  const [mode, setMode] = useState<Mode>(natural ? 'text' : 'chip')
  const [textBuf, setTextBuf] = useState(() => tagsJoined)
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [dragOrder, setDragOrder] = useState<string[] | null>(null)
  const dragOrderRef = useRef<string[] | null>(null)
  const textTagsRef = useRef([...tags])
  const previousResetKeyRef = useRef(resetKey)
  const draftInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // PointerSensor + 6px 启动距离：拖拽手感不会跟「点 × 删除」/ 误触冲突。
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

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
    const next = [...tags]
    dragOrderRef.current = next
    setDragOrder(next)
    setActiveTag(String(event.active.id))
  }

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event
    const current = dragOrderRef.current
    if (!current || !over || active.id === over.id) return
    const next = reorderTagFlow(current, String(active.id), String(over.id))
    if (next === current) return
    dragOrderRef.current = next
    setDragOrder(next)
  }

  const clearDragState = () => {
    setActiveTag(null)
    setDragOrder(null)
    dragOrderRef.current = null
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { over } = event
    const next = dragOrderRef.current ?? tags
    clearDragState()
    if (!over || tagsEqual(next, tags)) return
    onChange(next)
  }

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
            collisionDetection={pointerWithin}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={clearDragState}
          >
            <SortableContext items={dragOrder ?? tags} strategy={tagFlowSortingStrategy}>
              <div className="flex flex-wrap gap-1 overflow-y-auto flex-1 min-h-0 content-start py-1">
                {tags.length === 0 && (
                  <span className="text-xs text-fg-tertiary">{t('tagEditor.empty')}</span>
                )}
                {(dragOrder ?? tags).map((t) => (
                  <SortableChip key={t} id={t} onRemove={() => removeTag(t)} />
                ))}
              </div>
            </SortableContext>
            <DragOverlay adjustScale={false} dropAnimation={null}>
              {activeTag ? (
                <span
                  aria-hidden="true"
                  className={`${TAG_CHIP_CLASS} border-accent bg-surface shadow-lg cursor-grabbing pointer-events-none`}
                >
                  <TranslatedTag tag={activeTag} />
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
function SortableChip({ id, onRemove }: { id: string; onRemove: () => void }) {
  const { t } = useTranslation()
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging, isOver,
  } = useSortable({ id })
  const style: React.CSSProperties = {
    // FLIP movement is useful here; rect-based scale is not. Keeping translation
    // only prevents variable-width tags from stretching each other's text.
    transform: CSS.Translate.toString(transform),
    transition,
  }
  return (
    <span
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`${TAG_CHIP_CLASS} cursor-grab active:cursor-grabbing transition-[background-color,border-color,box-shadow,opacity] ${
        isDragging
          ? 'opacity-25'
          : isOver
            ? 'border-accent ring-2 ring-accent-soft'
            : 'opacity-100'
      }`}
    >
      <TranslatedTag tag={id} />
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onRemove}
        aria-label={t('tagEditor.deleteTag', { tag: id })}
        className="bg-transparent border-none text-fg-tertiary hover:text-err cursor-pointer p-0 text-sm leading-none"
      >
        ×
      </button>
    </span>
  )
}
