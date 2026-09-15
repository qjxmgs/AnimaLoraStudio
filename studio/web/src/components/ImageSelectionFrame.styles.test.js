import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const styles = readFileSync(resolve('src/styles/image-selection.css'), 'utf8')

it('keeps the selected-image frame three pixels wide and pointer transparent', () => {
  const base = styles.match(/^\.ui-image-selection-frame\s*\{([^}]*)\}/m)?.[1]
  expect(base).toBeDefined()
  expect(base).toContain('inset: 0')
  expect(base).toContain('box-shadow: inset 0 0 0 3px var(--accent)')
  expect(base).toContain('pointer-events: none')
  expect(styles).toContain('padding: 3px')
})

it('defines a transform-only RGB chase with a reduced-motion fallback', () => {
  expect(styles).toContain('#ff3040')
  expect(styles).toContain('#34d058')
  expect(styles).toContain('#3b82f6')
  expect(styles).toContain('animation: ui-image-selection-chase 2.2s linear infinite')
  expect(styles).toContain('rotate(1turn)')

  const reducedMotion = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce)'))
  expect(reducedMotion).toContain('animation: none')
  expect(reducedMotion).toContain('will-change: auto')
})
