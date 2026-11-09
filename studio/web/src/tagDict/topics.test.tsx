import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import seed from '../../../data/tag_topics.json'
import { explainTag, organizeTags } from './organize'
import { reloadTopics, useTagTopics, type TopicSnapshot } from './topics'

const snapshot = {
  ...seed, revision: 1,
  entries: Object.fromEntries(seed.entries.map((entry) => [entry.tag.replace(/_/g, ' '), { ...entry, source: 'builtin' }])),
} as unknown as TopicSnapshot
const categories = new Map<string, number>()
afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })

describe('semantic topic catalog', () => {
  it('groups related body terms without rewriting original tags or trigger slots', () => {
    const input = ['large_breasts', 'blue eyes', 'flat chest', 'breast', 'chest', 'long hair', 'custom_trigger']
    const output = organizeTags(input, categories, snapshot)
    expect(output).toEqual(['breast', 'chest', 'large_breasts', 'flat chest', 'blue eyes', 'long hair', 'custom_trigger'])
    expect(organizeTags(output, categories, snapshot)).toBe(output)
    expect(input[0]).toBe('large_breasts')
  })
  it('protects identities, exceptions, overrides and duplicates', () => {
    expect(explainTag('chest tattoo', categories, snapshot).topic).toBe('tattoos')
    expect(explainTag('chest harness', categories, snapshot).topic).toBe('harness')
    expect(explainTag('hand on chest', categories, snapshot).rank).toBe(5)
    expect(explainTag('chestnut', categories, snapshot).rank).toBeUndefined()
    const overridden = { ...snapshot, entries: { ...snapshot.entries, chest: { tag: 'chest', excluded: true, relation: 'related' as const, note: '', source: 'user' } } }
    expect(explainTag('chest', categories, overridden).reason).toBe('excluded')
    expect(explainTag('chest', new Map([['chest', 4]]), overridden).rank).toBe(1)
    const sorted = organizeTags(['blue eyes', 'chest', 'long hair', 'blue eyes'], categories, overridden)
    expect(sorted).toEqual(['blue eyes', 'chest', 'blue eyes', 'long hair'])
  })
  it('checks every authored grammar positive and negative', () => {
    for (const rule of snapshot.rules) {
      for (const tag of rule.positive) expect(explainTag(tag, categories, snapshot).topic).toBe(rule.topic)
      for (const tag of rule.negative) expect(explainTag(tag, categories, snapshot).topic).not.toBe(rule.topic)
    }
  })
  it('falls back to legacy organization when the first snapshot cannot load', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    await act(async () => reloadTopics())
    const { result } = renderHook(() => useTagTopics())
    expect(result.current.snapshot).toBeUndefined()
    expect(result.current.error).toBe('offline')
    expect(organizeTags(['highres', '1girl'], categories, result.current.snapshot)).toEqual(['1girl', 'highres'])
  })
  it('retains the last successful snapshot when refresh fails and invalidates via storage', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(snapshot)))
    await act(async () => reloadTopics())
    const { result } = renderHook(() => useTagTopics())
    expect(result.current.snapshot?.revision).toBe(1)
    fetch.mockRejectedValueOnce(new Error('offline'))
    await act(async () => reloadTopics())
    expect(result.current.error).toBe('offline')
    expect(result.current.snapshot?.revision).toBe(1)
    fetch.mockResolvedValue(new Response(JSON.stringify({ ...snapshot, revision: 2 })))
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'studio:tag-topics:revision', newValue: '2' })))
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(2))
    expect(result.current.error).toBeNull()
  })
  it('organizes ten thousand tags without changing their membership', () => {
    const tags = Array.from({ length: 10000 }, (_, i) => seed.entries[i % seed.entries.length].tag)
    const start = performance.now()
    const sorted = organizeTags(tags, categories, snapshot)
    const elapsed = performance.now() - start
    expect([...sorted].sort()).toEqual([...tags].sort())
    expect(organizeTags(sorted, categories, snapshot)).toBe(sorted)
    console.info(`10k tag organization: ${elapsed.toFixed(2)}ms`)
  })
})
