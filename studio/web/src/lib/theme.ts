import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'
export type Density = 'tight' | 'default' | 'loose'
export type ThemePreset = 'classic' | 'sakura' | 'sky' | 'star'
export interface Appearance {
  theme: Theme
  density: Density
  preset: ThemePreset
  effects: boolean
}

export const THEME_PRESETS: readonly ThemePreset[] = ['sakura', 'sky', 'star', 'classic']
const KEYS = {
  theme: 'studio.theme', density: 'studio.density',
  preset: 'studio.themePreset', effects: 'studio.themeEffects',
} as const

// Preferences still work for this session when browser storage is disabled.
const fallback = new Map<string, string>()
function safeGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return fallback.get(key) ?? null }
}
function safeSet(key: string, value: string): void {
  fallback.set(key, value)
  try { localStorage.setItem(key, value) } catch { /* session-only preference */ }
}

export function getStoredTheme(): Theme { return safeGet(KEYS.theme) === 'dark' ? 'dark' : 'light' }
export function getStoredDensity(): Density {
  const value = safeGet(KEYS.density)
  return value === 'tight' || value === 'loose' ? value : 'default'
}
export function getStoredThemePreset(): ThemePreset {
  const value = safeGet(KEYS.preset)
  if (value === null) return 'sky'
  return THEME_PRESETS.includes(value as ThemePreset) ? value as ThemePreset : 'classic'
}
export function getStoredThemeEffects(): boolean { return safeGet(KEYS.effects) !== 'false' }

function readAppearance(): Appearance {
  return { theme: getStoredTheme(), density: getStoredDensity(), preset: getStoredThemePreset(), effects: getStoredThemeEffects() }
}

let snapshot = readAppearance()
const listeners = new Set<() => void>()

function apply(next: Appearance): void {
  const root = document.documentElement
  root.classList.toggle('theme-dark', next.theme === 'dark')
  root.classList.toggle('density-tight', next.density === 'tight')
  root.classList.toggle('density-loose', next.density === 'loose')
  root.dataset.themePreset = next.preset
  root.dataset.themeEffects = String(next.effects)
  if (Object.keys(KEYS).every((key) => snapshot[key as keyof Appearance] === next[key as keyof Appearance])) return
  snapshot = next
  listeners.forEach((listener) => listener())
}

/** Changes CSS and subscribed chrome only; never keys/remounts route content. */
export function setAppearance(patch: Partial<Appearance>): void {
  for (const key of Object.keys(patch) as Array<keyof Appearance>) {
    const value = patch[key]
    if (value !== undefined) safeSet(KEYS[key], String(value))
  }
  apply({ ...snapshot, ...patch })
}

function onStorage(event: StorageEvent): void {
  if (event.key === null || Object.values(KEYS).some((key) => key === event.key)) initTheme()
}
function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('storage', onStorage)
  }
}
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
}

// Retain the existing persistence/apply API for callers outside appearance UI.
export function setStoredTheme(theme: Theme): void { safeSet(KEYS.theme, theme) }
export function applyTheme(theme: Theme): void { apply({ ...snapshot, theme }) }
export function setStoredDensity(density: Density): void { safeSet(KEYS.density, density) }
export function applyDensity(density: Density): void { apply({ ...snapshot, density }) }
export function toggleTheme(): Theme {
  const theme = snapshot.theme === 'dark' ? 'light' : 'dark'
  setAppearance({ theme })
  return theme
}
export function initTheme(): void { apply(readAppearance()) }

export type ThemeAsset = 'character-avatar' | 'character-avatar@2x'
  | 'character-card' | 'character-hero' | 'character-hero@2x'
  | `scene-${Theme}-1280` | `scene-${Theme}-1920`

export function themeAsset(preset: Exclude<ThemePreset, 'classic'>, asset: ThemeAsset): string {
  const extension = asset.startsWith('scene-') ? 'jpg' : 'png'
  return `/themes/${preset}/${asset}.${extension}`
}
