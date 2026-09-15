import { useEffect } from 'react'
import { useLocalStorageState } from '../../lib/useLocalStorageState'
import type { InpaintMode, InpaintTool } from './InpaintCanvas'

export interface InpaintBrushState {
  color: string
  size: number
  hardness: number
}

export const DEFAULT_INPAINT_BRUSH: InpaintBrushState = {
  color: '#ffffff',
  size: 24,
  hardness: 1,
}

export const INPAINT_TOOL_SHORTCUTS: Readonly<Record<string, InpaintTool>> = {
  KeyB: 'brush',
  KeyE: 'eraser',
  KeyL: 'lasso',
}

export const INPAINT_TOOL_SHORTCUT_LABELS: Readonly<Record<InpaintTool, string>> = {
  brush: 'B',
  eraser: 'E',
  lasso: 'L',
}

function legacyInpaintTool(): InpaintTool {
  if (typeof window === 'undefined') return 'brush'
  try {
    return JSON.parse(window.localStorage.getItem('studio:inpaint:erase') ?? 'false')
      ? 'eraser'
      : 'brush'
  } catch {
    return 'brush'
  }
}

export function useInpaintPreferences() {
  const [mode, setMode] = useLocalStorageState<InpaintMode>(
    'studio:inpaint:mode', 'paint',
  )
  const [tool, setTool] = useLocalStorageState<InpaintTool>(
    'studio:inpaint:tool', legacyInpaintTool(),
  )
  const [brush, setBrush] = useLocalStorageState<InpaintBrushState>(
    'studio:inpaint:brush', DEFAULT_INPAINT_BRUSH,
  )
  const [recentColors, setRecentColors] = useLocalStorageState<string[]>(
    'studio:inpaint:recent_colors', [],
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (window.localStorage.getItem('studio:inpaint:tool') === null) {
        window.localStorage.setItem('studio:inpaint:tool', JSON.stringify(tool))
      }
      if (tool !== 'lasso') {
        window.localStorage.setItem('studio:inpaint:erase', JSON.stringify(tool === 'eraser'))
      }
    } catch {
      // Preferences remain usable when storage is unavailable.
    }
  }, [tool])

  return {
    mode,
    setMode,
    tool,
    setTool,
    brush,
    setBrush,
    recentColors,
    setRecentColors,
  }
}

export function isInpaintTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
  ))
}

export function hasBlockingVisibleModal(owner: HTMLElement | null = null): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]')).some((modal) => {
    const style = window.getComputedStyle(modal)
    const visible = !modal.hidden && modal.getAttribute('aria-hidden') !== 'true' &&
      style.display !== 'none' && style.visibility !== 'hidden'
    return visible && (!owner || !modal.contains(owner))
  })
}

