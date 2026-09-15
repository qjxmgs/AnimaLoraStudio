/** Autocomplete 行为 hook —— 给 input / textarea 复用。
 *
 * 设计原则：hook 不修改用户的 value，仅在用户选中候选时回调 `onPick`。
 * caller 决定怎么落进数据（替换 token range / 推到 tags 数组 / append）。
 *
 * 弹出规则：候选只在输入变化（notifyChange）后弹出；聚焦不弹，鼠标点击
 * 输入框会关掉已弹出的候选。全局开关（Settings「Tag 翻译词典」区）关掉
 * 后所有入口都不弹。
 *
 * Token 模式：
 *   - `wholeAsToken: true`：整个 value 作为单 token。给 TagEditor chip 模式 input
 *     用（input 是 draft，本来就一段，commit 时直接 addTag(s.tag)）。
 *   - `tokenMode: 'prompt'`（默认）：根据 cursor + 逗号边界算当前 token。
 *   - `tokenMode: 'whitespace'`：根据空白边界算当前 token，供 Booru 查询等使用。
 *     后两者 commit 时都给 caller `range`，由 caller 切片替换。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'

import { useTagAutocompleteEnabled } from '../../tagDict/prefs'
import { useTagDict } from '../../tagDict/store'
import {
  extractCurrentToken,
  extractWhitespaceToken,
  findSuggestions,
  TAG_SUGGESTION_DEBOUNCE_MS,
  type ExtractedToken,
} from '../../tagDict/suggest'
import type { TagSuggestion } from '../../tagDict/types'

export interface TagSuggestPick {
  /** 选中的候选。 */
  suggestion: TagSuggestion
  /** 当前 token 在原 value 里的范围；wholeAsToken 时是 [0, value.length]。 */
  range: { start: number; end: number }
}

interface Args {
  value: string
  inputRef: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>
  onPick: (pick: TagSuggestPick) => void
  wholeAsToken?: boolean
  /** prompt=逗号/换行分隔；whitespace=Booru 等空白分隔查询。 */
  tokenMode?: 'prompt' | 'whitespace'
  /** 关掉 autocomplete（dict 未加载、字段 disabled 等场景）。 */
  disabled?: boolean
}

export interface TagSuggestApi {
  open: boolean
  /** 防抖查询尚未完成；上一批候选仅保留视觉，不允许提交。 */
  pending: boolean
  suggestions: TagSuggestion[]
  activeIdx: number
  setActiveIdx: (i: number) => void
  setOpen: (open: boolean) => void
  /** 在 input 的 onKeyDown 里第一句调；返回 true 表示已处理（caller 应 return）。 */
  handleKeyDown: (e: React.KeyboardEvent) => boolean
  /** 在 input 的 onChange 里调（防抖搜索 + 自动 open）。唯一的弹出入口。 */
  notifyChange: () => void
  /** 在 input 的 onBlur 里调（延迟关闭，给点击留时间）。 */
  notifyBlur: () => void
  /** 在 input 的 onClick 里调：鼠标点击移动光标 → 关掉已弹出的候选。 */
  notifyClick: () => void
  /** 鼠标点选 / 程序触发用。 */
  pickAt: (i: number) => void
}

export function useTagSuggest({
  value, inputRef, onPick, wholeAsToken = false, tokenMode = 'prompt', disabled = false,
}: Args): TagSuggestApi {
  const dict = useTagDict()
  const [acEnabled] = useTagAutocompleteEnabled()
  const off = disabled || !acEnabled
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const blurTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>())
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestValueRef = useRef(value)
  const [readyQuery, setReadyQuery] = useState<(ExtractedToken & { value: string }) | null>(null)
  latestValueRef.current = value

  const cancelPendingSearch = useCallback(() => {
    if (searchTimerRef.current === null) return
    clearTimeout(searchTimerRef.current)
    searchTimerRef.current = null
  }, [])

  useEffect(() => {
    const timers = blurTimersRef.current
    return () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      cancelPendingSearch()
    }
  }, [cancelPendingSearch])

  useEffect(() => {
    if (!off) return
    cancelPendingSearch()
    setPending(false)
    setReadyQuery(null)
    setOpen(false)
  }, [off, cancelPendingSearch])

  const suggestions = useMemo(() => {
    if (
      off || !open || dict.status !== 'ready' || !readyQuery?.token
      || readyQuery.value !== value
    ) return []
    return findSuggestions(readyQuery.token, {
      entries: dict.entries,
      searchIndex: dict.searchIndex,
      reverse: dict.reverse,
    })
  }, [
    off, open, readyQuery, value,
    dict.status, dict.entries, dict.searchIndex, dict.reverse,
  ])

  // suggestions 列表变化时重置 active
  const sugKey = suggestions.map((s) => s.tag).join('|')
  useEffect(() => { setActiveIdx(0) }, [sugKey])

  const pickAt = (i: number) => {
    if (pending) return
    const s = suggestions[i]
    if (!s || !readyQuery) return
    onPick({ suggestion: s, range: { start: readyQuery.start, end: readyQuery.end } })
    cancelPendingSearch()
    setPending(false)
    setReadyQuery(null)
    setOpen(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent): boolean => {
    if (off) return false
    if (e.key === 'Escape' && open) {
      e.preventDefault(); e.stopPropagation()
      cancelPendingSearch(); setPending(false); setReadyQuery(null); setOpen(false); return true
    }
    if (pending || !open || suggestions.length === 0) return false
    if (e.key === 'ArrowDown') {
      e.preventDefault(); setActiveIdx((activeIdx + 1) % suggestions.length); return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((activeIdx - 1 + suggestions.length) % suggestions.length); return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault(); pickAt(activeIdx); return true
    }
    return false
  }

  return {
    open, pending, suggestions, activeIdx, setActiveIdx,
    setOpen: (nextOpen) => {
      if (!nextOpen) {
        cancelPendingSearch()
        setPending(false)
        setReadyQuery(null)
      }
      setOpen(nextOpen)
    },
    handleKeyDown,
    notifyChange: () => {
      cancelPendingSearch()
      setReadyQuery(null)
      if (off) {
        setPending(false)
        setOpen(false)
        return
      }
      // Hook 中的旧候选立即失效；浮层在 pending 时只保留其视觉副本且不可操作。
      setPending(true)
      setOpen(true)
      searchTimerRef.current = setTimeout(() => {
        searchTimerRef.current = null
        const el = inputRef.current
        const currentValue = el?.value ?? latestValueRef.current
        const currentCursor = el?.selectionStart ?? currentValue.length
        const nextToken = wholeAsToken
          ? { token: currentValue.trim(), start: 0, end: currentValue.length }
          : tokenMode === 'whitespace'
            ? extractWhitespaceToken(currentValue, currentCursor)
            : extractCurrentToken(currentValue, currentCursor)
        setReadyQuery({ ...nextToken, value: currentValue })
        setPending(false)
        if (!nextToken.token) setOpen(false)
      }, TAG_SUGGESTION_DEBOUNCE_MS)
    },
    // 120ms 延迟：给 onMouseDown(pick) 时间完成；卸载时取消尚未执行的回调。
    notifyBlur: () => {
      cancelPendingSearch()
      setPending(false)
      const timer = setTimeout(() => {
        blurTimersRef.current.delete(timer)
        setOpen(false)
      }, 120)
      blurTimersRef.current.add(timer)
    },
    // 鼠标点击 = 用户在挪光标，不是在补全 → 关掉候选
    notifyClick: () => {
      cancelPendingSearch(); setPending(false); setReadyQuery(null); setOpen(false)
    },
    pickAt,
  }
}
