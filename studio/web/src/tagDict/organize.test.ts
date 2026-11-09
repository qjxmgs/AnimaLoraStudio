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
      'ass', 'long hair', 'purple hair', 'very long hair', 'hair between eyes',
      'mark under eye', 'blue eyes', 'ring light reflection', 'thighs', 'facial mark', 'shiny skin',
      'jewelry', 'thighhighs', 'white thighhighs', 'hair flower', 'hair ornament', 'earrings', 'ring',
      'looking at viewer', 'smile', 'blush', 'parted lips', 'flower', 'blue flower', 'indoors',
    ])
  })

  it('groups related subjects at their first occurrence, with the base tag first', () => {
    const tags = ['long hair', 'blue eyes', 'green hair', 'shiny skin', 'hair', 'eyes', 'red eyes', 'skin']
    const sorted = organizeTags(tags, categories)
    expect(sorted).toEqual(['hair', 'long hair', 'green hair', 'eyes', 'blue eyes', 'red eyes', 'skin', 'shiny skin'])
    expect(organizeTags(sorted, categories)).toBe(sorted)
  })

  it('groups modifiers even without a base tag and supports underscores without rewriting them', () => {
    expect(organizeTags(['blue_eyes', 'LONG_HAIR', 'green eyes', 'green_hair', 'ponytail'], categories))
      .toEqual(['blue_eyes', 'green eyes', 'LONG_HAIR', 'green_hair', 'ponytail'])
  })

  it('groups clothing and scene subjects without crossing category boundaries or trigger slots', () => {
    const tags = ['long hair', 'hair flower', 'blue shirt', 'skirt', 'white shirt',
      'custom_trigger', 'green hair', 'holding hair', 'blue sky', 'clouds', 'night sky', 'shirt']
    const sorted = organizeTags(tags, categories)
    expect(sorted).toEqual(['long hair', 'green hair', 'hair flower', 'shirt', 'blue shirt',
      'custom_trigger', 'white shirt', 'skirt', 'holding hair', 'blue sky', 'night sky', 'clouds'])
    expect(organizeTags(sorted, categories)).toBe(sorted)
    expect(tags[0]).toBe('long hair')
  })

  it('does not group identity labels by their apparent subject words', () => {
    const identities = new Map([['long hair', 4], ['hero', 4], ['green hair', 4]])
    const tags = ['long hair', 'hero', 'green hair']
    expect(organizeTags(tags, identities)).toBe(tags)
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
