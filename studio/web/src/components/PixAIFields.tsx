import { useTranslation } from 'react-i18next'
import { PIXAI_CATEGORIES, type PixAIConfig } from '../api/client'
import { Checkbox, Input, controlClassName } from './FormControl'
import { TagListInput } from './TagsInput'

export default function PixAIFields({ value, onChange, commitOnBlur = false }: {
  commitOnBlur?: boolean
  value: PixAIConfig
  onChange: (patch: Partial<PixAIConfig>) => void
}) {
  const { t } = useTranslation()
  return <>
    <p className="text-xs text-fg-secondary">{t('tag.pixaiThresholdHelp')}</p>
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {PIXAI_CATEGORIES.map(category => {
        const gate = `add_${category}_tag` as const
        const threshold = `threshold_${category}` as const
        const label = t(`tag.pixaiCategories.${category}`)
        return <div key={category} className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2"><Checkbox checked={value[gate]}
            onChange={event => onChange({ [gate]: event.target.checked })} />{label}</label>
          <Input aria-label={label + ' (0–1)'} type="number" min={0} max={1} step={0.01}
            className="max-w-24" value={value[threshold]} disabled={!value[gate]}
            onChange={event => {
              const number = event.target.valueAsNumber
              if (Number.isFinite(number)) onChange({ [threshold]: Math.max(0, Math.min(1, number)) })
            }} />
        </div>
      })}
    </div>
    <div className="flex flex-col gap-1">{t('settings.fieldBlacklistTags')}
      <TagListInput ariaLabel={t('settings.fieldBlacklistTags')} value={value.blacklist_tags}
        placeholder={t('tag.blacklistPlaceholder2')} commitOnBlur={commitOnBlur}
        className={controlClassName({ size: 'sm', surface: 'canvas' })}
        onChange={tags => onChange({ blacklist_tags: tags })} />
    </div>
  </>
}
