import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'

import { useLocalStorageState } from '../lib/useLocalStorageState'
import { TAG_CHIP_CLASS, tagChipStyle } from './tagDisplay/tagChipStyle'
import Button from './Button'
import { Input } from './FormControl'
import { TranslatedTag } from './tagDisplay/TranslatedTag'
import { TagSuggestList } from './tagSuggest/TagSuggestList'
import { useTagSuggest } from './tagSuggest/useTagSuggest'

type Sort = 'count_desc' | 'count_asc' | 'name_asc' | 'name_desc'

interface Props {
  inactiveDrafts?: ReadonlyMap<string, { order: string[]; inactive: string[] }>
  onToggleTag?: (tag: string) => void
  cache: Map<string, string[]>
  selectedKeys: string[]
  /** 点 tag 文字 = 选中所有含该 tag 的图（保留旧行为，仍是 tag 浏览的主路径）。 */
  onPickTag: (tag: string) => void
  /** 行内 × 按钮：从当前选中图中删除该 tag。未传时不渲染 ×（向后兼容）。 */
  onRemoveTag?: (tag: string) => void
  /** 行内 ✎ → inline edit：从当前选中图中把 oldTag 替换为 newTag。 */
  onReplaceTag?: (oldTag: string, newTag: string) => void
}

export default function TagStatsPanel({
  cache,
  inactiveDrafts,
  onToggleTag,
  selectedKeys,
  onPickTag,
  onRemoveTag,
  onReplaceTag,
}: Props) {
  const { t } = useTranslation()
  const [storedView, setView] = useLocalStorageState<string>('studio:tag-stats:view', 'list')
  const view = storedView === 'grid' ? 'grid' : 'list'
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<Sort>('count_desc')
  // inline replace state：editingTag = 正在 inline 改名的 tag；editValue 是
  // input 当前值。点 ✎ 进入；按 ✓ / 回车提交；按 ✕ / Esc / 失焦取消。
  const [editingTag, setEditingTag] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

  const usingSelection = selectedKeys.length > 0

  const counts = useMemo(() => {
    const active = new Map<string, number>()
    const total = new Map<string, number>()
    for (const key of selectedKeys) {
      const tags = new Set(cache.get(key) ?? [])
      for (const tag of tags) active.set(tag, (active.get(tag) ?? 0) + 1)
      const all = new Set([...tags, ...(inactiveDrafts?.get(key)?.inactive ?? [])])
      for (const tag of all) total.set(tag, (total.get(tag) ?? 0) + 1)
    }
    return { active, total }
  }, [cache, selectedKeys, inactiveDrafts])
  const items = useMemo(() => Array.from(
    view === 'grid' ? counts.total.keys() : counts.active.keys(),
    (tag): [string, number] => [tag, counts.active.get(tag) ?? 0],
  ), [counts, view])
  const toneIndexes = useMemo(() => new Map(
    [...counts.total.keys()].sort().map((tag, index) => [tag, index]),
  ), [counts])

  const sorted = useMemo(() => {
    const out = [...items]
    if (sort === 'count_desc') out.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    else if (sort === 'count_asc') out.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    else if (sort === 'name_asc') out.sort((a, b) => a[0].localeCompare(b[0]))
    else if (sort === 'name_desc') out.sort((a, b) => b[0].localeCompare(a[0]))
    return out
  }, [items, sort])

  const filtered = useMemo(() => {
    if (!filter.trim()) return sorted
    const f = filter.trim().toLowerCase()
    return sorted.filter(([tag]) => tag.toLowerCase().includes(f))
  }, [sorted, filter])

  const maxCount = Math.max(1, ...filtered.map(([, count]) => count))

  // 进入 edit mode 时 focus + select 输入框
  useEffect(() => {
    if (editingTag && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingTag])

  const startEdit = (tag: string) => {
    setEditingTag(tag)
    setEditValue(tag)
  }
  const cancelEdit = () => {
    setEditingTag(null)
    setEditValue('')
  }
  const commitEdit = () => {
    const o = editingTag
    const n = editValue.trim()
    if (!o || !n || n === o) { cancelEdit(); return }
    onReplaceTag?.(o, n)
    cancelEdit()
  }

  // 表头点击：在同列内切换方向；跨列默认进 desc（数字默认从多到少看，名字
  // 默认 A→Z）。两列各自记忆方向，跟 Excel / Numbers 等表格软件的直觉一致。
  const toggleNameSort = () => setSort(sort === 'name_asc' ? 'name_desc' : 'name_asc')
  const toggleCountSort = () => setSort(sort === 'count_desc' ? 'count_asc' : 'count_desc')
  const nameArrow = sort === 'name_asc' ? ' ↑' : sort === 'name_desc' ? ' ↓' : ''
  const countArrow = sort === 'count_desc' ? ' ↓' : sort === 'count_asc' ? ' ↑' : ''

  return (
    <section className="flex flex-col min-h-0 flex-1 min-w-0 overflow-hidden">
      <div className="px-2.5 py-1.5 border-b border-subtle flex items-center gap-2 text-xs shrink-0 flex-wrap">
        <span className="font-semibold text-fg-primary">{t('tagStats.title')}</span>
        {usingSelection && (
          <span className="px-1.5 py-px rounded-sm text-[10px] bg-accent-soft text-accent">
            {t('tagStats.selected', { n: selectedKeys.length })}
          </span>
        )}
        {usingSelection && (
          <span className="text-fg-tertiary">{t('tagStats.tagCount', { n: items.length })}</span>
        )}
        {usingSelection && (
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('common.filter')}
            aria-label={t('tagStats.filterLabel')}
            controlSize="sm"
            className="w-[120px]"
          />
        )}
        <span className="flex-1" />
        <div className="ml-auto flex shrink-0 gap-1" role="group" aria-label={t('tagStats.viewMode')}>
          {(['list', 'grid'] as const).map((mode) => (
            <Button key={mode} variant={view === mode ? 'secondary' : 'ghost'} size="sm" iconOnly
              aria-pressed={view === mode} aria-label={t(`tagStats.${mode}View`)}
              title={t(`tagStats.${mode}View`)} onClick={() => { cancelEdit(); setView(mode) }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                {mode === 'list' ? <path d="M5 3h9M5 8h9M5 13h9M1 3h1M1 8h1M1 13h1" />
                  : <path d="M1 1h5v5H1zM10 1h5v5h-5zM1 10h5v5H1zM10 10h5v5h-5z" />}
              </svg>
            </Button>
          ))}
        </div>
      </div>

      {/* table header：仅选中时显示。点击 header 切换该列排序方向 —— 类比
       * 表格软件「同列切方向 / 跨列默认 desc」直觉。活跃列旁带 ↑/↓ 指示
       * 当前方向，非活跃列不显示箭头避免视觉噪声。 */}
      {usingSelection && filtered.length > 0 && (
        <div className="px-2 py-1 border-b border-subtle flex items-center text-[10px] font-medium text-fg-tertiary shrink-0 gap-2">
          <button
            type="button"
            onClick={toggleNameSort}
            className="flex-1 min-w-0 text-left bg-transparent border-none cursor-pointer p-0 hover:text-fg-primary"
          >
            {t(view === 'grid' ? 'tagStats.headerName' : 'tagStats.headerTag')}{nameArrow}
          </button>
          <button
            type="button"
            onClick={toggleCountSort}
            className="shrink-0 bg-transparent border-none cursor-pointer p-0 hover:text-fg-primary"
          >
            {t('tagStats.headerCount')}{countArrow}
          </button>
          {/* 占位给 ✎ × 按钮列，让 header 跟下面行的列对齐（即使按钮 hover 才显示） */}
          {view === 'list' && (onReplaceTag || onRemoveTag) && (
            <span className="shrink-0" style={{ width: (onReplaceTag ? 16 : 0) + (onRemoveTag ? 16 : 0) }} />
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {!usingSelection ? (
          // 未选图：默认空状态 + 提示 user 先选图。比起"显示全部 tag 但操作
          // 不可用"，明确提示更不容易让 user 误以为 panel 坏了。
          <p className="px-2.5 py-3 text-xs text-fg-tertiary m-0 leading-relaxed">
            {t('tagStats.pleaseSelectFirst')}
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-2.5 py-2 text-xs text-fg-tertiary m-0">
            {filter.trim() ? t('tagStats.noMatch') : t('tagStats.noTagsSelected')}
          </p>
        ) : view === 'grid' ? (
          <div className="p-2 flex flex-wrap items-start content-start gap-2" data-testid="tag-stats-grid">
            {filtered.map(([tag, count]) => {
              const total = counts.total.get(tag) ?? count
              const inactive = count === 0
              const mixed = count > 0 && count < total
              return (
                <button key={tag} type="button" data-stats-tag={tag}
                  aria-pressed={mixed ? 'mixed' : !inactive}
                  aria-label={t(inactive ? 'tagStats.enableTag' : 'tagStats.disableTag', { tag })}
                  title={t(mixed ? 'tagStats.partiallyEnabled' : inactive ? 'tagStats.enableTag' : 'tagStats.disableTag', { tag })}
                  disabled={!onToggleTag} onClick={() => onToggleTag?.(tag)}
                  style={tagChipStyle(toneIndexes.get(tag) ?? 0, inactive)}
                  data-tag-inactive={inactive ? 'true' : 'false'}
                  className={`${TAG_CHIP_CLASS} max-w-full whitespace-normal text-left cursor-pointer ${mixed ? 'border-dashed' : ''}`}>
                  <span className={`min-w-0 break-words ${inactive ? 'line-through' : ''}`}>
                    <TranslatedTag tag={tag} layout="stacked" missingTranslation="-"
                      translationClassName="tag-chip-translation text-current opacity-70" />
                  </span>
                  <span className="self-start flex h-[1.15em] shrink-0 items-center text-sm">
                    <span className="rounded-sm px-1 text-xs leading-none font-mono bg-black/10" aria-label={t('tagStats.imageCount', { n: count, total })}>
                      {count < total ? `${count}/${total}` : count}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="p-1.5 flex flex-col gap-px">
            {filtered.map(([tag, c]) => {
              const pct = Math.max((c / maxCount) * 100, 3)
              const isEditing = editingTag === tag
              if (isEditing) {
                return (
                  <div
                    key={tag}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-sm bg-overlay"
                  >
                    <EditTagInput
                      tag={tag}
                      editInputRef={editInputRef}
                      value={editValue}
                      setValue={setEditValue}
                      onCommit={commitEdit}
                      onCancel={cancelEdit}
                    />
                    {/* onMouseDown 而不是 onClick：input 的 onBlur 会先触发，
                     * onClick 来时 commitEdit 已经被 cancelEdit 覆盖。
                     * mousedown 在 blur 之前触发，能拿到正确的 editValue。 */}
                    <Button
                      variant="primary"
                      size="xs"
                      iconOnly
                      onMouseDown={(e) => { e.preventDefault(); commitEdit() }}
                      aria-label={t('common.confirm')}
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg>
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      onMouseDown={(e) => { e.preventDefault(); cancelEdit() }}
                      aria-label={t('common.cancel')}
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
                    </Button>
                  </div>
                )
              }
              return (
                <div
                  key={tag}
                  className="group flex items-center gap-1 px-2 py-0.5 rounded-sm bg-transparent text-xs min-w-0 relative hover:bg-overlay transition-colors"
                >
                  <span style={{
                    position: 'absolute', inset: 0, borderRadius: 'var(--r-sm)',
                    background: 'var(--accent-soft)', opacity: pct / 100 * 0.35,
                    width: `${pct}%`, zIndex: 0,
                  }} />
                  <button
                    onClick={() => onPickTag(tag)}
                    title={t('tagStats.pickTagTitle', { tag })}
                    className="font-mono text-fg-primary flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap relative z-[1] text-left bg-transparent border-none cursor-pointer p-0"
                  >
                    <TranslatedTag tag={tag} />
                  </button>
                  <span className="text-fg-tertiary font-mono text-[10px] relative z-[1] shrink-0">
                    {c}
                  </span>
                  {onReplaceTag && (
                    <button
                      onClick={() => startEdit(tag)}
                      title={t('tagStats.replaceTitle', { tag })}
                      className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 relative z-[1] shrink-0 text-fg-tertiary hover:text-accent px-1 cursor-pointer bg-transparent border-none"
                      aria-label={t('tagStats.replaceTitle', { tag })}
                    >✎</button>
                  )}
                  {onRemoveTag && (
                    <button
                      onClick={() => onRemoveTag(tag)}
                      title={t('tagStats.removeTitle', { tag })}
                      className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 relative z-[1] shrink-0 text-fg-tertiary hover:text-danger px-1 cursor-pointer bg-transparent border-none"
                      aria-label={t('tagStats.removeTitle', { tag })}
                    >×</button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

/** Inline tag rename input + 翻译 autocomplete。抽出来是为了能放 useTagSuggest hook —
 *  父组件 .map 内部不能调 hook。 */
function EditTagInput({ tag, editInputRef, value, setValue, onCommit, onCancel }: {
  tag: string
  editInputRef: RefObject<HTMLInputElement>
  value: string
  setValue: (v: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const suggest = useTagSuggest({
    value,
    inputRef: editInputRef,
    wholeAsToken: true,
    onPick: ({ suggestion }) => setValue(suggestion.tag),
  })
  return (
    <div className="relative flex-1 min-w-0">
      <Input
        ref={editInputRef}
        value={value}
        onChange={(e) => { setValue(e.target.value); suggest.notifyChange() }}
        onKeyDown={(e) => {
          if (suggest.handleKeyDown(e)) return
          if (e.key === 'Enter') onCommit()
          else if (e.key === 'Escape') onCancel()
        }}
        onClick={() => suggest.notifyClick()}
        onBlur={() => { suggest.notifyBlur(); onCancel() }}
        aria-label={t('tagStats.replaceInputLabel', { tag })}
        controlSize="sm"
        mono
        className="w-full"
      />
      <TagSuggestList
        open={suggest.open}
        pending={suggest.pending}
        suggestions={suggest.suggestions}
        activeIdx={suggest.activeIdx}
        onPick={(s) => suggest.pickAt(suggest.suggestions.indexOf(s))}
        onHover={suggest.setActiveIdx}
        inputRef={editInputRef}
      />
    </div>
  )
}
