import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import Button from './Button'
import { Input, Textarea } from './FormControl'

interface Props {
  tags: string[]
  activeTags: ReadonlySet<string>
  busy?: boolean
  resetKey?: string
  onPick: (tag: string) => void
  onAdd: (tag: string) => void | Promise<void>
  onDelete: (tag: string) => void | Promise<void>
  onReplace: (tags: string[]) => void | Promise<void>
}

const normalizeDraft = (raw: string): string => (
  raw.trim().replace(/^[,，]+|[,，]+$/g, '').trim()
)

const formatTextTags = (tags: string[]): string => tags.join('\n')

const parseTextTags = (raw: string): string[] => {
  const result: string[] = []
  const seen = new Set<string>()
  raw.split(/\r?\n/).forEach((line) => {
    const tag = line.trim()
    if (!tag || seen.has(tag)) return
    seen.add(tag)
    result.push(tag)
  })
  return result
}

const tagsEqual = (left: string[], right: string[]): boolean => (
  left.length === right.length && left.every((tag, index) => tag === right[index])
)

export default function ProjectCustomTags({
  tags,
  activeTags,
  busy = false,
  resetKey,
  onPick,
  onAdd,
  onDelete,
  onReplace,
}: Props) {
  const { t } = useTranslation()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [textEditing, setTextEditing] = useState(false)
  const [textDraft, setTextDraft] = useState(() => formatTextTags(tags))
  const [armedTag, setArmedTag] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const textInputRef = useRef<HTMLTextAreaElement>(null)
  const textModePointerHandledRef = useRef(false)
  const normalizedDraft = normalizeDraft(draft)
  const duplicate = useMemo(
    () => normalizedDraft.length > 0 && tags.includes(normalizedDraft),
    [normalizedDraft, tags],
  )

  useEffect(() => {
    setArmedTag(null)
  }, [resetKey])

  useEffect(() => {
    if (armedTag && !tags.includes(armedTag)) setArmedTag(null)
  }, [armedTag, tags])

  useEffect(() => {
    if (!adding) return
    inputRef.current?.focus()
  }, [adding])

  useEffect(() => {
    if (textEditing) return
    setTextDraft(formatTextTags(tags))
  }, [tags, textEditing])

  useEffect(() => {
    if (!textEditing) return
    textInputRef.current?.focus()
  }, [textEditing])

  useEffect(() => {
    if (!armedTag) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setArmedTag(null)
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element) || !target.closest('[data-custom-tag-delete]')) {
        setArmedTag(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [armedTag])

  const closeAdd = () => {
    setAdding(false)
    setDraft('')
  }

  const submitAdd = () => {
    if (!normalizedDraft || duplicate || busy) return
    void onAdd(normalizedDraft)
    closeAdd()
  }

  const commitTextDraft = () => {
    const nextTags = parseTextTags(textDraft)
    if (busy || tagsEqual(nextTags, tags)) return
    void onReplace(nextTags)
  }

  const closeTextEditor = () => {
    setTextEditing(false)
  }

  const openAddEditor = () => {
    setArmedTag(null)
    closeTextEditor()
    setAdding(true)
  }

  return (
    <section
      aria-label={t('tagEditor.customTagsLabel')}
      className={`flex shrink-0 flex-col overflow-hidden rounded-[6px] border border-subtle bg-sunken ${
        textEditing ? 'min-h-0 max-h-none basis-1/2' : 'max-h-36'
      }`}
    >
      <div
        data-custom-tags-header
        className="flex h-10 shrink-0 items-center gap-2 border-b border-subtle bg-surface px-2 py-1"
      >
        <span className="shrink-0 text-xs font-medium text-fg-secondary">
          {t('tagEditor.customTagsHeading')}
        </span>

        <div className="ml-auto flex min-w-0 items-center justify-end gap-1">
          {adding ? (
            <>
              <Input
                ref={inputRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    closeAdd()
                  } else if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
                    event.preventDefault()
                    submitAdd()
                  }
                }}
                disabled={busy}
                invalid={duplicate}
                aria-label={t('tagEditor.customTagInputLabel')}
                title={duplicate ? t('tagEditor.customTagDuplicate') : undefined}
                placeholder={t('tagEditor.customTagPlaceholder')}
                controlSize="sm"
                mono
                className="min-w-0 flex-1"
              />
              <Button
                variant="primary"
                size="xs"
                iconOnly
                disabled={!normalizedDraft || duplicate || busy}
                onClick={submitAdd}
                aria-label={t('tagEditor.customTagConfirm')}
              >
                ✓
              </Button>
              <Button
                variant="ghost"
                size="xs"
                iconOnly
                disabled={busy}
                onClick={closeAdd}
                aria-label={t('common.cancel')}
              >
                ×
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                size="xs"
                iconOnly
                disabled={busy}
                aria-label={t('tagEditor.customTagsTextMode')}
                aria-pressed={textEditing}
                className={textEditing ? 'border-info bg-info-soft text-info' : undefined}
                onPointerDown={(event) => {
                  if (!textEditing) return
                  event.preventDefault()
                  textModePointerHandledRef.current = true
                  commitTextDraft()
                  closeTextEditor()
                }}
                onPointerCancel={() => { textModePointerHandledRef.current = false }}
                onClick={() => {
                  if (textModePointerHandledRef.current) {
                    textModePointerHandledRef.current = false
                    return
                  }
                  setArmedTag(null)
                  setTextDraft(formatTextTags(tags))
                  setTextEditing(true)
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M5 6h14M5 12h14M5 18h9" />
                </svg>
              </Button>
              <Button
                variant="secondary"
                size="xs"
                iconOnly
                disabled={busy}
                onPointerDown={(event) => {
                  if (!textEditing) return
                  event.preventDefault()
                  commitTextDraft()
                  openAddEditor()
                }}
                onClick={() => {
                  if (textEditing) return
                  openAddEditor()
                }}
                aria-label={t('tagEditor.customTagCreate')}
              >
                +
              </Button>
            </>
          )}
        </div>
      </div>

      {textEditing ? (
        <div className="flex min-h-0 flex-1 p-2">
          <Textarea
            ref={textInputRef}
            value={textDraft}
            onChange={(event) => setTextDraft(event.target.value)}
            onBlur={commitTextDraft}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setTextDraft(formatTextTags(tags))
                closeTextEditor()
              } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                commitTextDraft()
              }
            }}
            disabled={busy}
            aria-label={t('tagEditor.customTagsTextInputLabel')}
            placeholder={t('tagEditor.customTagsTextPlaceholder')}
            controlSize="sm"
            mono
            className="min-h-0 flex-1 resize-none"
          />
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-wrap content-start gap-1.5 overflow-y-auto p-2">
          {tags.map((tag) => {
            const unavailable = activeTags.has(tag)
            const armed = armedTag === tag
            return (
              <span
                key={tag}
                className={`inline-flex h-7 max-w-full overflow-hidden whitespace-nowrap rounded-[5px] border font-mono text-xs ${
                  unavailable
                    ? 'border-subtle bg-overlay text-fg-disabled'
                    : 'border-info bg-info-soft text-info'
                }`}
              >
                <button
                  type="button"
                  disabled={busy || unavailable}
                  onClick={() => {
                    setArmedTag(null)
                    onPick(tag)
                  }}
                  className="min-w-0 max-w-48 truncate border-none bg-transparent px-2.5 text-left text-current enabled:cursor-pointer enabled:hover:bg-hover enabled:hover:text-fg-primary disabled:cursor-not-allowed"
                  title={unavailable
                    ? t('tagEditor.customTagUnavailable', { tag })
                    : t('tagEditor.customTagAdd', { tag })}
                >
                  {tag}
                </button>
                <button
                  type="button"
                  data-custom-tag-delete
                  disabled={busy}
                  aria-label={armed
                    ? t('tagEditor.customTagDeleteConfirm', { tag })
                    : t('tagEditor.customTagDelete', { tag })}
                  aria-pressed={armed}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (!armed) {
                      setArmedTag(tag)
                      return
                    }
                    setArmedTag(null)
                    void onDelete(tag)
                  }}
                  className="flex w-7 shrink-0 items-center justify-center border-0 border-l border-subtle bg-transparent font-sans font-bold text-danger enabled:cursor-pointer enabled:hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {armed ? '!' : '×'}
                </button>
              </span>
            )
          })}
        </div>
      )}
    </section>
  )
}
