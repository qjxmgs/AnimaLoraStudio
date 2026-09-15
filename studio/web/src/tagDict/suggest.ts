/** Tag autocomplete — 纯函数。
 *
 * 两件事：
 * 1. extractCurrentToken：从输入文本 + cursor 位置算出"当前正在输入的 token"
 *    及其在原串里的 range（commit 时用来切片替换）。逗号边界兼容 ASCII `,`
 *    和中文 `，`；换行也作为分隔（textarea 多行场景）。
 * 2. findSuggestions：根据 token 找 prefix + fuzzy 候选；含 CJK 自动走
 *    反向索引；按 prefix 优先，同组内保持词典原始顺序（CSV 按 post_count DESC）。
 */
import type { ReverseEntry, TagSuggestion } from './types'

const CJK_RE = /[一-鿿]/

const SEPARATORS = new Set([',', '，', '\n'])
const WHITESPACE_RE = /\s/

export const TAG_SUGGESTION_LIMIT = 50
export const TAG_SUGGESTION_DEBOUNCE_MS = 40
const FUZZY_QUOTA_RATIO = 0.4
const TAG_SEARCH_CACHE_LIMIT = 32

export interface ExtractedToken {
  /** trim 后的查询文本（喂给 findSuggestions）。 */
  token: string
  /** 原串中 token 实际占位的 start 索引（含 leading 空格）。 */
  start: number
  /** end 索引（exclusive；含 trailing 空格但不含分隔符）。 */
  end: number
}

/** 从光标位置往两边扫到最近分隔符或边界，返回当前 token + range。
 *
 * range 边界规则：包含 token 周围的空白（commit 时一并替换，避免双空格）。
 * 不修改原串；不处理分隔符本身。 */
export function extractCurrentToken(value: string, cursor: number): ExtractedToken {
  const cur = Math.max(0, Math.min(cursor, value.length))
  let start = cur
  while (start > 0 && !SEPARATORS.has(value[start - 1])) start--
  let end = cur
  while (end < value.length && !SEPARATORS.has(value[end])) end++
  const raw = value.slice(start, end)
  const token = raw.trim()
  return { token, start, end }
}

/** Booru 查询用：空白分隔 tag；负向/OR 前缀不参与词典匹配，但保留在替换 range。 */
export function extractWhitespaceToken(value: string, cursor: number): ExtractedToken {
  const cur = Math.max(0, Math.min(cursor, value.length))
  let start = cur
  while (start > 0 && !WHITESPACE_RE.test(value[start - 1])) start--
  let end = cur
  while (end < value.length && !WHITESPACE_RE.test(value[end])) end++
  const raw = value.slice(start, end).trim()
  const token = raw.replace(/^[-~]/, '')
  return { token, start, end }
}

/** suggest 入口需要的 store 切片；分离出来便于测试注入。 */
export interface SuggestStore {
  entries: Map<string, string[]>
  searchIndex: TagSearchIndex
  reverse: ReverseEntry[]
}

/** 是否含 CJK 字符 —— 决定走英文正向还是中文反向。 */
export function hasCjk(s: string): boolean {
  return CJK_RE.test(s)
}

export interface TagMatch {
  tag: string
  matchType: TagSuggestion['matchType']
}

interface InternalCandidate extends TagMatch {
  tag: string
  zh: string[]
}

function toSuggestion(c: InternalCandidate): TagSuggestion {
  return {
    tag: c.tag,
    zh: c.zh,
    matchType: c.matchType,
  }
}

function pushUnique<T extends TagMatch>(out: T[], seen: Set<string>, c: T, limit: number): void {
  if (out.length >= limit) return
  if (seen.has(c.tag)) return
  seen.add(c.tag)
  out.push(c)
}

function compactTag(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]/g, '')
}

function wordInitials(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join('')
}

export interface TagSearchIndex {
  /** 保持词典或项目候选的原始顺序。 */
  tagKeys: readonly string[]
  /** 去空格和下划线并转为小写，与 tagKeys 同下标。 */
  compactedKeys: readonly string[]
  /** 单词首字母串，与 tagKeys 同下标。 */
  wordInitialKeys: readonly string[]
  /** 每个索引独立持有的查询结果 LRU；重建索引即失效。 */
  cache: Map<string, readonly TagMatch[]>
}

/** 候选源变化时构建一次，避免每次按键重新规范化整份词典。 */
export function buildTagSearchIndex(
  tagKeys: readonly string[],
  compactedKeys?: readonly string[],
): TagSearchIndex {
  const compacted = tagKeys.map((tag, index) => (
    compactedKeys?.[index] ?? compactTag(tag)
  ).toLowerCase())
  return {
    tagKeys,
    compactedKeys: compacted,
    wordInitialKeys: tagKeys.map(wordInitials),
    cache: new Map(),
  }
}

function isOrderedSubsequence(query: string, candidate: string): boolean {
  let queryIndex = 0
  for (let i = 0; i < candidate.length && queryIndex < query.length; i++) {
    if (candidate[i] === query[queryIndex]) queryIndex++
  }
  return queryIndex === query.length
}

function mergeMatchGroups<T extends TagMatch>(prefix: T[], fuzzy: T[], limit: number): T[] {
  const max = Math.max(0, Math.floor(limit))
  if (max === 0) return []
  const fuzzyReserve = Math.min(fuzzy.length, Math.floor(max * FUZZY_QUOTA_RATIO))
  const prefixCount = Math.min(prefix.length, max - fuzzyReserve)
  const fuzzyCount = Math.min(fuzzy.length, max - prefixCount)
  return [...prefix.slice(0, prefixCount), ...fuzzy.slice(0, fuzzyCount)]
}

/** 英文标签候选的共享排序：prefix 在前，fuzzy 在后；默认 30 + 20，短缺互补。 */
export function findTagMatches(
  rawToken: string,
  index: TagSearchIndex,
  limit = TAG_SUGGESTION_LIMIT,
  excludedTag?: string,
): TagMatch[] {
  const compactToken = compactTag(rawToken)
  const max = Math.max(0, Math.floor(limit))
  if (!compactToken || max === 0) return []

  const excluded = excludedTag?.trim().toLowerCase() ?? ''
  const cacheKey = `${compactToken}\u0000${max}\u0000${excluded}`
  const cached = index.cache.get(cacheKey)
  if (cached) {
    // Map 的插入顺序充当 LRU；命中后移到队尾。
    index.cache.delete(cacheKey)
    index.cache.set(cacheKey, cached)
    return cached as TagMatch[]
  }

  const prefix: TagMatch[] = []
  const initial: TagMatch[] = []
  const substring: TagMatch[] = []
  const subsequence: TagMatch[] = []
  const seen = new Set<string>()
  const fuzzyQuota = Math.floor(max * FUZZY_QUOTA_RATIO)
  const prefixQuota = max - fuzzyQuota

  for (let i = 0; i < index.tagKeys.length; i++) {
    const tag = index.tagKeys[i]
    if (excluded && tag.toLowerCase() === excluded) continue
    if (seen.has(tag)) continue
    const compacted = index.compactedKeys[i]
    let target: TagMatch[] | null = null
    let matchType: TagSuggestion['matchType'] = 'fuzzy'
    if (compacted.startsWith(compactToken)) {
      target = prefix
      matchType = 'prefix'
    } else if (index.wordInitialKeys[i].startsWith(compactToken)) {
      target = initial
    } else if (compacted.includes(compactToken)) {
      target = substring
      matchType = 'substring'
    } else if (isOrderedSubsequence(compactToken, compacted)) {
      target = subsequence
    }
    if (!target) continue
    pushUnique(target, seen, { tag, matchType }, max)

    // 头部配额和最高优先级的跨词配额都已满足时，后续扫描不可能改变结果。
    if (prefix.length >= prefixQuota && initial.length >= fuzzyQuota) break
  }

  const result = mergeMatchGroups(prefix, [...initial, ...substring, ...subsequence], max)
  index.cache.set(cacheKey, result)
  if (index.cache.size > TAG_SEARCH_CACHE_LIMIT) {
    const oldestKey = index.cache.keys().next().value
    if (oldestKey !== undefined) index.cache.delete(oldestKey)
  }
  return result
}

/** 给定查询 token 找候选；空 token / 未加载 → []。
 *
 * 顺序：prefix 组在前，组内保持扫描顺序（英文 = 词典行序即热度；
 * 中文 = zh 长度升序，见 store.buildReverse）。 */
export function findSuggestions(
  rawToken: string,
  store: SuggestStore,
  limit = TAG_SUGGESTION_LIMIT,
): TagSuggestion[] {
  const token = rawToken.trim().toLowerCase()
  if (!token) return []
  if (!store.searchIndex.tagKeys.length && !store.reverse.length) return []

  const goChinese = hasCjk(token)

  if (goChinese) {
    const max = Math.max(0, Math.floor(limit))
    const prefix: InternalCandidate[] = []
    const substring: InternalCandidate[] = []
    const seen = new Set<string>()
    // 中文反向：扫 reverse 数组里 zh 字段 prefix / substring
    for (const re of store.reverse) {
      if (re.zh === token || re.zh.startsWith(token)) {
        for (const tag of re.tags) {
          pushUnique(prefix, seen, {
            tag, zh: store.entries.get(tag) ?? [], matchType: 'prefix',
          }, max)
          if (prefix.length >= max) break
        }
      }
      if (prefix.length >= max) break
    }
    for (const re of store.reverse) {
      if (!re.zh.startsWith(token) && re.zh.includes(token)) {
        for (const tag of re.tags) {
          pushUnique(substring, seen, {
            tag, zh: store.entries.get(tag) ?? [], matchType: 'substring',
          }, max)
          if (substring.length >= max) break
        }
      }
      if (substring.length >= max) break
    }
    return mergeMatchGroups(prefix, substring, max).map(toSuggestion)
  }

  return findTagMatches(token, store.searchIndex, limit).map((candidate) => ({
    ...candidate,
    zh: store.entries.get(candidate.tag) ?? [],
  }))
}
