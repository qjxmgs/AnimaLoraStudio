import type React from 'react'

export const TAG_TONES = [
  '#768eca', // blue
  '#5da6ba', // cyan
  '#66af83', // green
  '#9b79ca', // purple
  '#bd79a1', // pink
] as const

export const TAG_CHIP_CLASS =
  'relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] border px-2.5 py-1.5 select-none touch-none'

type TagToneStyle = React.CSSProperties & { '--tag-tone': string }

const tagToneStyle = (index: number): TagToneStyle => ({
  '--tag-tone': TAG_TONES[index % TAG_TONES.length],
  color: 'color-mix(in srgb, var(--tag-tone) var(--tag-text-tone-weight, 72%), var(--fg-primary))',
  backgroundColor: 'color-mix(in srgb, var(--tag-tone) 22%, var(--bg-surface))',
  borderColor: 'var(--tag-tone)',
})

const inactiveTagStyle: React.CSSProperties = {
  color: 'var(--tag-inactive-fg)',
  backgroundColor: 'var(--tag-inactive-bg)',
  borderColor: 'var(--tag-inactive-border)',
}

export const tagChipStyle = (index: number, inactive: boolean): React.CSSProperties => (
  inactive ? inactiveTagStyle : tagToneStyle(index)
)

