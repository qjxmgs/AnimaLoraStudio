import { useTranslation } from 'react-i18next'
import { setAppearance, themeAsset, THEME_PRESETS, useAppearance, type ThemePreset } from '../lib/theme'

/** Compact previews avoid fetching unselected full-size theme artwork. */
export default function ThemePicker() {
  const { t } = useTranslation()
  const { preset, theme } = useAppearance()
  const select = (value: ThemePreset) => setAppearance({ preset: value })
  return (
    <div className="theme-picker" role="radiogroup" aria-label={t('appearance.preset')}>
      {THEME_PRESETS.map((id, index) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={preset === id}
          aria-label={t(`appearance.presets.${id}.name`)}
          tabIndex={preset === id ? 0 : -1}
          className="theme-picker-card"
          data-preview-preset={id}
          data-preview-mode={theme}
          onClick={() => select(id)}
          onKeyDown={(event) => {
            let next: number | undefined
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % THEME_PRESETS.length
            if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + THEME_PRESETS.length - 1) % THEME_PRESETS.length
            if (event.key === 'Home') next = 0
            if (event.key === 'End') next = THEME_PRESETS.length - 1
            if (next === undefined) return
            event.preventDefault()
            select(THEME_PRESETS[next])
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
          }}
        >
          <span className="theme-picker-preview" aria-hidden="true">
            <span className="theme-preview-rail"><i /><i /><i /></span>
            <span className="theme-preview-panel"><i /><i /><b /></span>
            {id !== 'classic' && (
              <img src={themeAsset(id, 'character-card')} width="131" height="192" alt="" />
            )}
          </span>
          <span className="theme-picker-name">{t(`appearance.presets.${id}.name`)}<span aria-hidden="true">{preset === id ? '✓' : ''}</span></span>
          <span className="theme-picker-description">{t(`appearance.presets.${id}.description`)}</span>
        </button>
      ))}
    </div>
  )
}
