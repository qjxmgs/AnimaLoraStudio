import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Button from '../Button'

interface Props {
  disabled: boolean
  canClearCurrent: boolean
  canClearAll: boolean
  onAuto: () => void
  onClear: (all: boolean) => void
}

export default function MaskActionsMenu({ disabled, canClearCurrent, canClearAll, onAuto, onClear }: Props) {
  const { t } = useTranslation()
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const leaveTimer = useRef<number>()
  const cancelLeave = () => window.clearTimeout(leaveTimer.current)
  useEffect(() => cancelLeave, [])
  const focusFirst = useRef(false)

  useEffect(() => {
    if (!open) return
    if (disabled) { setOpen(false); return }
    if (focusFirst.current) {
      root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
      focusFirst.current = false
    }
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (root.current?.contains(document.activeElement)) trigger.current?.focus()
      setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open, disabled])

  function openWithFocus() {
    if (open) root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    else focusFirst.current = true
    setOpen(true)
  }

  const actions = [
    { key: 'openSetup', run: onAuto, disabled: false },
    { key: 'clearCurrent', run: () => onClear(false), disabled: !canClearCurrent },
    { key: 'clearAll', run: () => onClear(true), disabled: !canClearAll },
  ]

  return (
    <div className="relative" ref={root}
      onMouseEnter={() => { cancelLeave(); if (!disabled) setOpen(true) }}
      onMouseLeave={() => {
        leaveTimer.current = window.setTimeout(() => {
          if (!root.current?.querySelector('[role="menu"] :focus')) setOpen(false)
        }, 150)
      }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}
    >
      <Button ref={trigger} variant="ghost" size="sm" disabled={disabled}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={openWithFocus}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); openWithFocus() }
        }}
      >{t('preprocessInpaint.headMask.actions')}</Button>
      {open && !disabled && (
        <div id={id} role="menu" aria-label={t('preprocessInpaint.headMask.actions')}
          className="absolute top-full right-0 z-50 min-w-max rounded-md border border-subtle bg-surface p-1 shadow-lg"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:enabled'))
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
          }}
        >
          {actions.map((action) => (
            <button key={action.key} type="button" role="menuitem" disabled={action.disabled}
              className="block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-overlay focus-visible:bg-overlay disabled:opacity-50"
              onClick={() => { trigger.current?.focus(); setOpen(false); action.run() }}
            >{t(`preprocessInpaint.headMask.${action.key}`)}</button>
          ))}
        </div>
      )}
    </div>
  )
}
