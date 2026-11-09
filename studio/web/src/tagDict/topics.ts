import { useEffect, useSyncExternalStore } from 'react'

export interface Topic {
  id: string; name: string; zh: string; rank: number; parent: string | null
  group: string; kind: 'family' | 'topic'; source?: 'builtin' | 'user'
}
export interface TopicEntry {
  tag: string; topic?: string | null; base?: boolean; excluded?: boolean
  relation: 'base' | 'variant' | 'related' | 'modifier' | 'exception'; note: string; source?: string
}
export interface TopicRule {
  id: string; topic: string; kind: 'modifier'; heads: string[]; modifiers: string[]
  positive: string[]; negative: string[]
}
export interface TopicSnapshot {
  revision: number; version: number; topics: Topic[]; entries: Record<string, TopicEntry>
  rules: TopicRule[]; fallback: { rank: number; pattern: string }[]
}
export interface TopicMatch {
  tag: string; topic?: string; rank?: number; group?: string; base?: boolean; source: string; reason: string
}

export async function topicRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/tag-topics${path}`, {
    ...init, headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    const detail = error?.detail
    throw new Error(typeof detail === 'string' ? detail : Array.isArray(detail)
      ? detail.map((item: { loc?: string[]; msg?: string }) => `${item.loc?.join('.') ?? ''}: ${item.msg ?? ''}`).join('; ')
      : `HTTP ${response.status}`)
  }
  return response.json()
}

type State = { snapshot: TopicSnapshot | undefined; loading: boolean; error: string | null }
let state: State = { snapshot: undefined, loading: false, error: null }
let pending: Promise<void> | undefined
const listeners = new Set<() => void>()
const emit = (next: State) => { state = next; listeners.forEach((fn) => fn()) }
const CACHE = 'studio:tag-topics:last-snapshot'
const REVISION = 'studio:tag-topics:revision'
const valid = (value: unknown): value is TopicSnapshot => {
  const v = value as TopicSnapshot | null
  try {
    return Boolean(v && Number.isInteger(v.revision)
      && Array.isArray(v.topics) && v.topics.every((t) => t && typeof t.id === 'string' && Number.isInteger(t.rank) && typeof t.group === 'string')
      && v.entries && typeof v.entries === 'object' && Object.values(v.entries).every((e) => e && typeof e.tag === 'string')
      && Array.isArray(v.rules) && v.rules.every((r) => r && Array.isArray(r.heads) && Array.isArray(r.modifiers))
      && Array.isArray(v.fallback) && v.fallback.every((r) => Number.isInteger(r.rank) && typeof r.pattern === 'string' && Boolean(new RegExp(r.pattern))))
  } catch { return false }
}

export function reloadTopics(notify = false): Promise<void> {
  if (pending) return notify ? pending.then(() => reloadTopics(true)) : pending
  if (!state.snapshot) {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(CACHE) ?? 'null')
      if (valid(saved)) state = { ...state, snapshot: saved }
    } catch { /* A cache is optional. */ }
  }
  emit({ ...state, loading: true })
  pending = topicRequest<TopicSnapshot>('/snapshot').then((snapshot) => {
    if (!valid(snapshot)) throw new Error('Invalid topic snapshot')
    emit({ snapshot, loading: false, error: null })
    try {
      localStorage.setItem(CACHE, JSON.stringify(snapshot))
      if (notify) localStorage.setItem(REVISION, `${snapshot.revision}:${Date.now()}`)
    } catch { /* Keep the in-memory snapshot when storage is unavailable. */ }
  }).catch((error: unknown) => {
    emit({ ...state, loading: false, error: error instanceof Error ? error.message : String(error) })
  }).finally(() => { pending = undefined })
  return pending
}

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export function useTagTopics() {
  const current = useSyncExternalStore(subscribe, () => state)
  useEffect(() => {
    if (!state.snapshot && !state.error) void reloadTopics()
    const refresh = () => { void reloadTopics() }
    const storage = (event: StorageEvent) => { if (event.key === REVISION) refresh() }
    window.addEventListener('focus', refresh)
    window.addEventListener('storage', storage)
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('storage', storage) }
  }, [])
  return current
}
