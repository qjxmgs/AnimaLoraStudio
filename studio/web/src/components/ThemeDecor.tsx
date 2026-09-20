import { useTranslation } from 'react-i18next'
import { themeAsset, useAppearance } from '../lib/theme'

/** Pure decoration, with no hit targets and no background image on editing surfaces. */
export function ThemeWelcomeArt() {
  const { preset, theme } = useAppearance()
  if (preset === 'classic') return null
  return (
    <div className="theme-welcome-art" aria-hidden="true">
      <img
        className="theme-welcome-scene"
        src={themeAsset(preset, `scene-${theme}-1280`)}
        srcSet={`${themeAsset(preset, `scene-${theme}-1280`)} 1280w, ${themeAsset(preset, `scene-${theme}-1920`)} 1920w`}
        sizes="100vw"
        alt=""
      />
      <div className="theme-welcome-scrim" />
      <div className="theme-welcome-orbit" />
      <img
        className="theme-welcome-character"
        src={themeAsset(preset, 'character-hero')}
        srcSet={`${themeAsset(preset, 'character-hero')} 1x, ${themeAsset(preset, 'character-hero@2x')} 2x`}
        alt=""
      />
      <span className="theme-welcome-spark theme-welcome-spark-one">✦</span>
      <span className="theme-welcome-spark theme-welcome-spark-two">✧</span>
    </div>
  )
}

export function ThemeSignature({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const { preset } = useAppearance()
  if (preset === 'classic') return null
  return (
    <span className={`theme-signature ${compact ? 'theme-signature-compact' : ''}`}>
      <span aria-hidden="true">{preset === 'sakura' ? '✿' : preset === 'sky' ? '✦' : '◇'}</span>
      {t(`appearance.presets.${preset}.name`)}
    </span>
  )
}

/** Compact current-theme portrait for the persistent sidebar brand. */
export function ThemeBrandAvatar() {
  const { preset } = useAppearance()
  if (preset === 'classic') return null
  return (
    <img
      className="theme-brand-avatar"
      src={themeAsset(preset, 'character-avatar')}
      srcSet={`${themeAsset(preset, 'character-avatar')} 1x, ${themeAsset(preset, 'character-avatar@2x')} 2x`}
      width="40"
      height="40"
      alt=""
      aria-hidden="true"
    />
  )
}

export function ThemeMascot({ mood = 'welcome', className = '' }: {
  mood?: 'welcome' | 'empty' | 'success' | 'error'
  className?: string
}) {
  const { preset } = useAppearance()
  if (preset === 'classic') return null
  const expression = { welcome: 'smug', empty: 'conf2', success: 'heart', error: 'confused' }[mood]
  return <img className={`theme-mascot ${className}`} src={`/icons/noal_${expression}.png`} alt="" aria-hidden="true" />
}
