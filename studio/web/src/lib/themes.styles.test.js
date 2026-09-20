import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve('src/styles/themes.css'), 'utf8')

function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map((value) => {
    const channel = parseInt(value, 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
}
function contrast(a, b) {
  const l = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (l[0] + 0.05) / (l[1] + 0.05)
}
function mix(a, b, weight) {
  const channels = (hex) => hex.slice(1).match(/../g).map((v) => parseInt(v, 16))
  const back = channels(b)
  return '#' + channels(a).map((value, i) => Math.round(value * weight + back[i] * (1 - weight)).toString(16).padStart(2, '0')).join('')
}

describe('theme text contrast', () => {
  for (const preset of ['sakura', 'sky', 'star']) {
    for (const mode of ['light', 'dark']) {
      it(`${preset}/${mode} keeps normal text and solid controls at 4.5:1`, () => {
        const selector = `:root[data-theme-preset="${preset}"]${mode === 'dark' ? '.theme-dark' : ':not(.theme-dark)'} {`
        const block = css.slice(css.indexOf(selector) + selector.length).split('}')[0]
        const tokens = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[a-f\d]{6});/gi)].map((match) => [match[1], match[2]]))
        for (const fg of ['fg-primary', 'fg-secondary', 'fg-tertiary']) {
          for (const bg of ['bg-canvas', 'bg-surface', 'bg-sunken', 'bg-overlay', 'bg-elevated']) {
            expect(contrast(tokens[fg], tokens[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
          }
        }
        for (const [fg, bg] of [['accent-strong', 'accent-soft'], ['accent-fg', 'accent-control'], ['accent-fg', 'accent-control-hover'], ['accent', 'bg-canvas']]) {
          expect(contrast(tokens[fg], tokens[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
        }
        // The category hues stay stable; both primary and translated tag text
        // must remain readable after blending with the named palette.
        const weightRule = mode === 'light' ? '--tag-text-tone-weight: 36%' : '--tag-text-tone-weight: 38%'
        expect(css).toContain(weightRule)
        for (const tone of ['#768eca', '#5da6ba', '#66af83', '#9b79ca', '#bd79a1']) {
          const bg = mix(tone, tokens['bg-surface'], .22)
          const fg = mix(tone, tokens['fg-primary'], mode === 'light' ? .36 : .38)
          expect(contrast(mix(fg, bg, .9), bg), `translated ${tone} tag`).toBeGreaterThanOrEqual(4.5)
        }
      })
    }
  }
})
