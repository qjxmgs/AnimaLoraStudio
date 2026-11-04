import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

interface Target {
  name: string
  x: number
  y: number
  source: HTMLElement
  reveal: (name: string) => void
}

/** One portal per image list; thumbnails keep no menu state or global listeners. */
export function useImageContextMenu(onReveal: ((name: string) => void) | undefined, items: unknown) {
  const [target, setTarget] = useState<Target | null>(null)
  const close = useCallback(() => setTarget(null), [])
  useEffect(close, [close, items])

  const onContextMenu = useCallback((name: string, event: MouseEvent<HTMLElement>) => {
    if (!onReveal) return
    event.preventDefault()
    event.stopPropagation()
    setTarget({ name, x: event.clientX, y: event.clientY, source: event.currentTarget, reveal: onReveal })
  }, [onReveal])

  const onKeyDown = useCallback((name: string, event: KeyboardEvent<HTMLElement>) => {
    if (!onReveal || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) return
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    setTarget({ name, x: rect.left + 16, y: rect.top + 16, source: event.currentTarget, reveal: onReveal })
  }, [onReveal])

  return {
    onContextMenu: onReveal ? onContextMenu : undefined,
    onKeyDown: onReveal ? onKeyDown : undefined,
    menu: target ? <ImageContextMenu key={`${target.name}:${target.x}:${target.y}`} target={target} onClose={close} /> : null,
  }
}

function ImageContextMenu({ target, onClose }: { target: Target; onClose: () => void }) {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(target.x, window.innerWidth - rect.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(target.y, window.innerHeight - rect.height - 8))}px`
    buttonRef.current?.focus({ preventScroll: true })
  }, [target])

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        if (target.source.isConnected) target.source.focus({ preventScroll: true })
      } else if (event.key === 'Tab') {
        onClose()
        if (target.source.isConnected) target.source.focus({ preventScroll: true })
      } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        event.stopPropagation()
        buttonRef.current?.focus({ preventScroll: true })
      }
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', keydown, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', keydown, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose, target])

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('imageGrid.contextMenu', { name: target.name })}
      className="fixed z-[80] min-w-36 max-w-[calc(100vw-16px)] rounded border border-subtle bg-elevated p-1 shadow-xl"
      style={{ left: target.x, top: target.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        ref={buttonRef}
        type="button"
        role="menuitem"
        className="w-full rounded px-3 py-2 text-left text-sm text-fg-primary hover:bg-sunken focus-visible:bg-sunken focus-visible:outline-none"
        onClick={(event) => {
          event.stopPropagation()
          onClose()
          if (target.source.isConnected) target.source.focus({ preventScroll: true })
          target.reveal(target.name)
        }}
      >
        {t('imageGrid.revealImage')}
      </button>
    </div>,
    document.body,
  )
}
