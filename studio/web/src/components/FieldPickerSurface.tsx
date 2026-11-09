import { useEffect, useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/** Table layouts need a viewport-bounded picker above their scroll/stacking contexts. */
export default function FieldPickerSurface({ children, portal, anchorRef, popRef, onClose }: {
  children: ReactNode
  portal: boolean
  anchorRef: RefObject<HTMLElement | null>
  popRef: RefObject<HTMLDivElement>
  onClose: () => void
}) {
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    if (!portal || !anchorRef.current || !popRef.current) return
    const field = anchorRef.current.closest('.train-field') ?? anchorRef.current
    const rect = field.getBoundingClientRect()
    const gutter = 16
    const width = Math.min(Math.max(420, rect.width), window.innerWidth - gutter * 2)
    const left = Math.max(gutter, Math.min(rect.left, window.innerWidth - width - gutter))
    const below = window.innerHeight - rect.bottom - gutter - 4
    const above = rect.top - gutter - 4
    const height = Math.min(360, popRef.current.scrollHeight)
    const upwards = below < height && above > below
    setPosition({
      width, left, maxHeight: Math.max(32, Math.min(360, upwards ? above : below)),
      ...(upwards ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
    })
  }, [portal, anchorRef, popRef, children])

  useEffect(() => {
    if (!portal) return
    const scroll = (event: Event) => {
      if (event.target instanceof Node && popRef.current?.contains(event.target)) return
      onClose()
    }
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', onClose)
    }
  }, [portal, popRef, onClose])

  const surface = <div ref={popRef} data-field-picker
    className={`${portal ? 'fixed z-50' : 'absolute z-40 mt-1'} max-h-[360px] overflow-y-auto rounded-md border border-dim bg-elevated shadow-xl text-xs`}
    style={portal ? position : { top: '100%', left: 0, width: '100%', minWidth: 420 }}>
    {children}
  </div>
  return portal ? createPortal(surface, document.body) : surface
}
