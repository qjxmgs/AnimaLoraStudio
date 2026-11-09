import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const styles = readFileSync(resolve('src/styles/train-table.css'), 'utf8')

it('uses one table container for 1/2/4 columns without packing fields out of schema order', () => {
  expect(styles).toContain('@container train-table (min-width: 800px)')
  expect(styles).toContain('@container train-table (min-width: 1440px)')
  expect(styles).not.toMatch(/grid-auto-flow:\s*[^;]*dense/)
  expect(styles).not.toContain('--parameter-columns: 3')
})
