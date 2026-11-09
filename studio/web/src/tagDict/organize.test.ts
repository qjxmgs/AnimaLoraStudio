import { describe, expect, it } from 'vitest'
import { organizeTags, semanticTagRank } from './organize'

const categories = new Map([['wuthering waves', 3], ['cantarella (wuthering waves)', 4]])

describe('semantic prompt organization', () => {
  it('sorts the screenshot tags by meaning, preserving the order within each group', () => {
    const tags = ['wuthering waves', 'cantarella (wuthering waves)', '1girl',
      'ass', 'long hair', 'flower', 'jewelry', 'purple hair', 'thighhighs',
      'blue flower', 'looking at viewer', 'hair flower', 'solo', 'indoors',
      'mark under eye', 'hair ornament', 'earrings', 'blue eyes', 'thighs',
      'very long hair', 'ring light reflection', 'smile', 'facial mark',
      'hair between eyes', 'white thighhighs', 'shiny skin', 'blush', 'ring', 'parted lips']
    expect(organizeTags(tags, categories)).toEqual([
      'wuthering waves', 'cantarella (wuthering waves)', '1girl', 'solo',
      'ass', 'long hair', 'purple hair', 'mark under eye', 'blue eyes', 'thighs',
      'very long hair', 'ring light reflection', 'facial mark', 'hair between eyes', 'shiny skin',
      'jewelry', 'thighhighs', 'hair flower', 'hair ornament', 'earrings', 'white thighhighs', 'ring',
      'looking at viewer', 'smile', 'blush', 'parted lips', 'flower', 'blue flower', 'indoors',
    ])
  })

  it('preserves unknown trigger slots, exact spelling, duplicates, and input', () => {
    const tags = ['my_trigger', 'best quality', 'blue_eyes', 'unknown phrase', '1girl', 'blue_eyes']
    const before = [...tags]
    const sorted = organizeTags(tags, categories)
    expect(sorted).toEqual(['my_trigger', '1girl', 'blue_eyes', 'unknown phrase', 'blue_eyes', 'best quality'])
    expect(tags).toEqual(before)
    expect(organizeTags(sorted, categories)).toBe(sorted)
  })

  it('uses identity metadata before general words and does not guess from parentheses', () => {
    expect(semanticTagRank('Blue_Eyes', new Map([['blue eyes', 4]]))).toBe(1)
    expect(semanticTagRank('unknown (series)', categories)).toBeUndefined()
    expect(organizeTags(['  LONG_HAIR  ', '1girl'], new Map())).toEqual(['1girl', '  LONG_HAIR  '])
  })

  it('keeps specific expression, action and accessory tags out of the anatomy group', () => {
    expect(organizeTags([
      'highres', 'indoors', 'upper body', 'closed eyes', 'hair flower', 'blue eyes', 'solo',
    ], categories)).toEqual([
      'solo', 'blue eyes', 'hair flower', 'closed eyes', 'upper body', 'indoors', 'highres',
    ])
    expect(semanticTagRank('holding hair', categories)).toBe(5)
    expect(semanticTagRank('hair ornament', categories)).toBe(4)
  })

  it('leaves empty, single and unrecognized lists unchanged', () => {
    for (const tags of [[], ['solo'], ['trigger', 'unknown']]) {
      expect(organizeTags(tags, categories)).toBe(tags)
    }
  })
})
