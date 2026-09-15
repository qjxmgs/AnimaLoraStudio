import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import Button from './Button'
import { Input } from './FormControl'

interface Props {
  tags: string[]
  activeTags: ReadonlySet<string>
  busy?: boolean
  resetKey?: string
  onPick: (tag: string) => void
  onAdd: (tag: string) => void | Promise<void>
  onDelete: (tag: string) => void | Promise<void>
}

const normalizeDraft = (raw: string): string => (
  raw.trim().replace(/^[,，]+|[,，]+$/g, '').trim()
)

export default function ProjectCustomTags({
  tags,
  activeTags,
  busy = false,
  resetKey,
  onPick,
  onAdd,
  onDelete,
}: Props) {
  const { t } = useTranslation()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [armedTag, setArmedTag] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
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

  return (
    <section
      aria-label={t('tagEditor.customTagsLabel')}
      className="flex max-h-28 shrink-0 gap-2 overflow-hidden rounded-[6px] border border-subtle bg-sunken p-2"
    >
      <div className="flex min-w-0 flex-1 flex-wrap content-start gap-1.5 overflow-y-auto pr-0.5">
        {tags.map((tag) => {
          const unavailable = activeTags.has(tag)
          const armed = armedTag === tag
          return (
            <span
              key={tag}
              className={`inline-flex h-7 max-w-full overflow-hidden whitespace-nowrap rounded-[5px] border font-mono text-xs ${
                unavailable
                  ? 'border-subtle bg-sunken text-fg-disabled'
                  : 'border-default bg-overlay text-fg-secondary'
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

      <div className="flex shrink-0 items-start gap-1">
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
              className="w-32"
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
          <Button
            variant="secondary"
            size="xs"
            iconOnly
            disabled={busy}
            onClick={() => {
              setArmedTag(null)
              setAdding(true)
            }}
            aria-label={t('tagEditor.customTagCreate')}
          >
            +
          </Button>
        )}
      </div>
    </section>
  )
}
