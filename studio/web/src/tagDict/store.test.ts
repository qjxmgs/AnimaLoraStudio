import { afterEach, describe, expect, it, vi } from 'vitest'
import { __setStateForTest, _getInternalState, reloadDict } from './store'

describe('dictionary identity metadata', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    __setStateForTest({ status: 'empty', entries: new Map(), categories: new Map() })
  })

  it('loads categories and clears them when replaced by a legacy or user dictionary', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      entries: { series: ['作品'], hero: ['角色'] },
      categories: { series: 3, hero: 4 },
    })))
    await reloadDict()
    expect(_getInternalState().categories).toEqual(new Map([['series', 3], ['hero', 4]]))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ entries: { custom: [] } })))
    await reloadDict()
    expect(_getInternalState().categories.size).toBe(0)
  })

  it('clears metadata if the dictionary is removed', async () => {
    __setStateForTest({ categories: new Map([['series', 3]]) })
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 }))
    await reloadDict()
    expect(_getInternalState().categories.size).toBe(0)
    expect(_getInternalState().status).toBe('empty')
  })
})
