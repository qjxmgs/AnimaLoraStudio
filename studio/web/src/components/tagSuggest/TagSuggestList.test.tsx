import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TagSuggestion } from '../../tagDict/types'
import { TagSuggestList } from './TagSuggestList'

const SOLO: TagSuggestion = { tag: 'solo', zh: ['单人'], matchType: 'prefix' }
const LONG_HAIR: TagSuggestion = { tag: 'long hair', zh: ['长发'], matchType: 'prefix' }
const ORIGINAL_INNER_WIDTH = window.innerWidth
const ORIGINAL_INNER_HEIGHT = window.innerHeight

function rect(left: number, top: number, width = 400, height = 32): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }
}

function renderSuggestList({
  inputRect = rect(120, 100),
  suggestions = [SOLO],
  pending = false,
}: {
  inputRect?: DOMRect
  suggestions?: TagSuggestion[]
  pending?: boolean
} = {}) {
  const input = document.createElement('input')
  document.body.appendChild(input)
  const getRect = vi.fn(() => inputRect)
  input.getBoundingClientRect = getRect
  const inputRef = { current: input }
  const onPick = vi.fn()
  const onHover = vi.fn()
  const view = render(
    <TagSuggestList
      open
      pending={pending}
      suggestions={suggestions}
      activeIdx={0}
      onPick={onPick}
      onHover={onHover}
      inputRef={inputRef}
    />,
  )
  return { ...view, input, inputRef, getRect, onPick, onHover }
}

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: ORIGINAL_INNER_WIDTH })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: ORIGINAL_INNER_HEIGHT })
})

describe('TagSuggestList input anchoring', () => {
  it('stays aligned to the input while pending and replaces candidates in place', () => {
    const { rerender, inputRef, getRect, onPick, onHover } = renderSuggestList()
    const list = screen.getByRole('listbox')
    expect(list).toHaveStyle({ left: '120px', top: '136px', maxHeight: '260px' })

    rerender(
      <TagSuggestList
        open
        pending
        suggestions={[]}
        activeIdx={0}
        onPick={onPick}
        onHover={onHover}
        inputRef={inputRef}
      />,
    )
    expect(screen.getByRole('listbox')).toBe(list)
    expect(list).toHaveStyle({ left: '120px', top: '136px' })
    expect(list).toHaveAttribute('aria-busy', 'true')
    const staleOption = screen.getByRole('option')
    expect(staleOption).toHaveAttribute('aria-disabled', 'true')
    fireEvent.mouseEnter(staleOption)
    fireEvent.mouseDown(staleOption)
    expect(onHover).not.toHaveBeenCalled()
    expect(onPick).not.toHaveBeenCalled()
    expect(getRect).toHaveBeenCalledTimes(1)

    rerender(
      <TagSuggestList
        open
        pending={false}
        suggestions={[LONG_HAIR]}
        activeIdx={0}
        onPick={onPick}
        onHover={onHover}
        inputRef={inputRef}
      />,
    )
    expect(screen.getByRole('listbox')).toBe(list)
    expect(list).toHaveStyle({ left: '120px', top: '136px' })
    expect(screen.getByText('long hair')).toBeInTheDocument()
    expect(screen.queryByText('solo')).not.toBeInTheDocument()
    expect(getRect).toHaveBeenCalledTimes(1)
  })

  it('flips above the input and clamps its left edge near the viewport boundary', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 })
    renderSuggestList({ inputRect: rect(900, 700, 80, 32) })

    expect(screen.getByRole('listbox')).toHaveStyle({
      left: '772px',
      bottom: '72px',
      maxHeight: '260px',
    })
  })

  it('repositions only when the input geometry changes through scrolling', () => {
    let currentRect = rect(80, 100)
    const { getRect } = renderSuggestList({ inputRect: currentRect })
    const list = screen.getByRole('listbox')
    expect(list).toHaveStyle({ left: '80px', top: '136px' })

    currentRect = rect(40, 200)
    getRect.mockImplementation(() => currentRect)
    fireEvent.scroll(window)
    expect(list).toHaveStyle({ left: '40px', top: '236px' })
  })

  it('follows an input resize without depending on its text content', () => {
    const OriginalResizeObserver = globalThis.ResizeObserver
    let resizeCallback: ResizeObserverCallback = () => {}
    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) { resizeCallback = callback }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
    try {
      let currentRect = rect(60, 100, 400, 32)
      const { getRect } = renderSuggestList({ inputRect: currentRect })
      const list = screen.getByRole('listbox')
      expect(list).toHaveStyle({ top: '136px' })

      currentRect = rect(60, 100, 400, 96)
      getRect.mockImplementation(() => currentRect)
      act(() => { resizeCallback([], {} as ResizeObserver) })
      expect(list).toHaveStyle({ top: '200px' })
    } finally {
      globalThis.ResizeObserver = OriginalResizeObserver
    }
  })

  it('closes after a completed query returns no candidates', () => {
    const { rerender, inputRef, onPick, onHover } = renderSuggestList()
    rerender(
      <TagSuggestList
        open
        pending={false}
        suggestions={[]}
        activeIdx={0}
        onPick={onPick}
        onHover={onHover}
        inputRef={inputRef}
      />,
    )
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
