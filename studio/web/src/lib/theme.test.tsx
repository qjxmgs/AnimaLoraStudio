import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyDensity, applyTheme, getStoredThemePreset, initTheme, setAppearance,
  setStoredDensity, setStoredTheme, toggleTheme, useAppearance,
} from './theme'
import ThemePicker from '../components/ThemePicker'
import { ThemeWelcomeArt } from '../components/ThemeDecor'
import { DisplaySection } from '../pages/tools/settings/sections'

function Observer() {
  const value = useAppearance()
  return <output data-testid="appearance">{JSON.stringify(value)}</output>
}

beforeEach(() => {
  localStorage.clear()
  initTheme()
})
afterEach(() => vi.restoreAllMocks())

describe('appearance lifecycle', () => {
  it('defaults to Sky Club without changing an existing dark/loose preference', () => {
    localStorage.setItem('studio.theme', 'dark')
    localStorage.setItem('studio.density', 'loose')
    initTheme()
    expect(document.documentElement.dataset.themePreset).toBe('sky')
    expect(document.documentElement).toHaveClass('theme-dark', 'density-loose')
    expect(document.documentElement.dataset.themeEffects).toBe('true')
  })

  it('restores each dimension and falls back to Classic for an unknown preset', () => {
    setAppearance({ preset: 'sakura', theme: 'dark', density: 'tight', effects: false })
    initTheme()
    render(<Observer />)
    expect(screen.getByTestId('appearance')).toHaveTextContent('"preset":"sakura"')
    expect(document.documentElement.dataset.themeEffects).toBe('false')
    localStorage.setItem('studio.themePreset', 'unknown-theme')
    act(() => initTheme())
    expect(getStoredThemePreset()).toBe('classic')
    expect(document.documentElement.dataset.themePreset).toBe('classic')
    expect(document.documentElement).toHaveClass('theme-dark', 'density-tight')
  })

  it('updates both legacy APIs and subscribed controls immediately', () => {
    render(<><Observer /><DisplaySection /></>)
    act(() => { setStoredTheme('dark'); applyTheme('dark') })
    expect(screen.getByRole('radio', { name: /暗色/ })).toHaveAttribute('aria-checked', 'true')
    act(() => { setStoredDensity('loose'); applyDensity('loose') })
    expect(screen.getByRole('radio', { name: '宽松' })).toHaveAttribute('aria-checked', 'true')
    act(() => toggleTheme())
    expect(screen.getByRole('radio', { name: /日间/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: '星轨终端' }))
    expect(screen.getByTestId('appearance')).toHaveTextContent('"preset":"star"')
    expect(screen.getByTestId('appearance')).toHaveTextContent('"density":"loose"')
    fireEvent.click(screen.getByRole('checkbox', { name: '装饰动效' }))
    expect(localStorage.getItem('studio.themeEffects')).toBe('false')
  })

  it('keeps working in memory when storage reads and writes throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    render(<Observer />)
    act(() => setAppearance({ preset: 'star', theme: 'dark', density: 'default', effects: false }))
    act(() => toggleTheme())
    expect(document.documentElement).not.toHaveClass('theme-dark')
    act(() => initTheme())
    expect(screen.getByTestId('appearance')).toHaveTextContent('"preset":"star"')
    expect(screen.getByTestId('appearance')).toHaveTextContent('"theme":"light"')
    expect(document.documentElement.dataset.themeEffects).toBe('false')
  })

  it('synchronizes external storage changes and clears without remounting editors', () => {
    render(<><Observer /><input aria-label="draft" defaultValue="unsaved text" /><div data-testid="scroll" /></>)
    const input = screen.getByRole('textbox', { name: 'draft' }) as HTMLInputElement
    const scroller = screen.getByTestId('scroll')
    input.focus()
    input.setSelectionRange(2, 6)
    scroller.scrollTop = 73
    localStorage.setItem('studio.themePreset', 'star')
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'studio.themePreset' })))
    expect(screen.getByRole('textbox', { name: 'draft' })).toBe(input)
    expect(input).toHaveFocus()
    expect(input.value).toBe('unsaved text')
    expect(input.selectionStart).toBe(2)
    expect(scroller.scrollTop).toBe(73)
    expect(document.documentElement.dataset.themePreset).toBe('star')
    localStorage.clear()
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })))
    expect(document.documentElement.dataset.themePreset).toBe('sky')
  })
})

describe('theme gallery and artwork', () => {
  it('supports roving keyboard focus and preserves mode/density while selecting themes', () => {
    setAppearance({ theme: 'dark', density: 'tight' })
    render(<ThemePicker />)
    const sky = screen.getByRole('radio', { name: '晴空社团' })
    sky.focus()
    fireEvent.keyDown(sky, { key: 'ArrowRight' })
    const star = screen.getByRole('radio', { name: '星轨终端' })
    expect(star).toHaveFocus()
    expect(star).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(star, { key: 'End' })
    const classic = screen.getByRole('radio', { name: '经典' })
    expect(classic).toHaveFocus()
    fireEvent.keyDown(classic, { key: 'ArrowRight' })
    expect(screen.getByRole('radio', { name: '樱糖应援' })).toHaveFocus()
    expect(document.documentElement).toHaveClass('theme-dark', 'density-tight')
  })

  it('loads only the active full-size art and removes it for Classic', () => {
    const { container } = render(<><ThemeWelcomeArt /><ThemePicker /></>)
    const largeImages = () => Array.from(container.querySelectorAll<HTMLImageElement>('.theme-welcome-art img')).map((image) => image.getAttribute('src'))
    const responsiveSources = () => Array.from(container.querySelectorAll<HTMLImageElement>('.theme-welcome-art img')).map((image) => image.getAttribute('srcset'))
    const cardImages = () => Array.from(container.querySelectorAll<HTMLImageElement>('.theme-picker-preview img')).map((image) => image.getAttribute('src'))
    expect(largeImages()).toEqual(['/themes/sky/scene-light-1280.jpg', '/themes/sky/character-hero.png'])
    expect(responsiveSources()).toEqual([
      '/themes/sky/scene-light-1280.jpg 1280w, /themes/sky/scene-light-1920.jpg 1920w',
      '/themes/sky/character-hero.png 1x, /themes/sky/character-hero@2x.png 2x',
    ])
    expect(cardImages()).toEqual([
      '/themes/sakura/character-card.png',
      '/themes/sky/character-card.png',
      '/themes/star/character-card.png',
    ])
    expect(container.querySelector('.theme-preview-symbol')).toBeNull()
    act(() => setAppearance({ preset: 'sakura', theme: 'dark' }))
    expect(largeImages()).toEqual(['/themes/sakura/scene-dark-1280.jpg', '/themes/sakura/character-hero.png'])
    act(() => setAppearance({ preset: 'classic' }))
    expect(largeImages()).toEqual([])
  })
})
