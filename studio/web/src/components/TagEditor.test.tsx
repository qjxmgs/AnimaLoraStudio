import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __setTagPrefsForTest } from '../tagDict/prefs'
import { __setStateForTest } from '../tagDict/store'
import TagEditor, {
  reorderTagFlow,
  resolveTagCenterDrop,
  TAG_TONES,
  tagFlowSortingStrategy,
} from './TagEditor'

class PointerEventPolyfill extends MouseEvent {
  pointerId: number
  isPrimary: boolean
  pointerType: string

  constructor(type: string, props: PointerEventInit = {}) {
    super(type, props)
    this.pointerId = props.pointerId ?? 0
    this.isPrimary = props.isPrimary ?? true
    this.pointerType = props.pointerType ?? 'mouse'
  }
}

const pointerWindow = window as unknown as { PointerEvent?: typeof PointerEvent }
if (!pointerWindow.PointerEvent) {
  pointerWindow.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent
}

const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
  x: left,
  y: top,
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  toJSON: () => ({}),
})

describe('TagEditor (PP4 chip mode)', () => {
  beforeEach(() => {
    __setStateForTest({ status: 'empty', entries: new Map() })
    __setTagPrefsForTest({ loaded: true, showTranslation: true })
  })

  it('renders chips for each tag', () => {
    const { container } = render(<TagEditor tags={['a', 'b']} onChange={() => {}} />)
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('b')).toBeInTheDocument()
    expect(screen.getByText('2 个标签')).toBeInTheDocument()
    expect(container.querySelector('[data-tag-chip="a"]')?.tagName).toBe('BUTTON')
    expect(screen.queryByLabelText('删除 a')).not.toBeInTheDocument()
  })

  it('shows project quick tags in both modes and reactivates a pending tag', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const props = {
      tags: ['pending'],
      inactiveTags: new Set(['pending']),
      customTags: ['pending', 'new tag'],
      onChange,
      onAddCustomTag: vi.fn(),
      onDeleteCustomTag: vi.fn(),
    }
    render(<TagEditor {...props} />)

    let palette = screen.getByRole('region', { name: '项目常驻标签' })
    expect(within(palette).getByRole('button', { name: /^pending$/ })).toBeEnabled()
    await user.click(within(palette).getByRole('button', { name: /^pending$/ }))
    expect(onChange).toHaveBeenLastCalledWith(['pending'], new Set())

    await user.click(screen.getByText('文本'))
    palette = screen.getByRole('region', { name: '项目常驻标签' })
    expect(palette).toBeInTheDocument()
  })

  it('reorders variable-width chips without strategy-level scaling', () => {
    expect(tagFlowSortingStrategy({
      activeNodeRect: null,
      activeIndex: 0,
      index: 1,
      overIndex: 1,
      rects: [],
    })).toBeNull()
    expect(reorderTagFlow(
      ['short', 'a much longer translated tag', 'third'],
      'short',
      'third',
      'after',
    )).toEqual(['a much longer translated tag', 'third', 'short'])
    render(<TagEditor tags={['short', 'a much longer translated tag']} onChange={() => {}} />)
    expect(screen.getByText('short').closest('[data-tag-chip]')).toHaveClass(
      'shrink-0',
      'whitespace-nowrap',
    )
  })

  it('stacks English over Chinese and uses a dash when translation is missing', () => {
    __setStateForTest({
      status: 'ready',
      entries: new Map([
        ['long hair', ['长发']],
        ['white shirt', ['白衬衫', '白上衣']],
      ]),
    })
    render(<TagEditor tags={['long_hair', 'white shirt', 'unknown']} onChange={() => {}} />)

    expect(screen.getByText('long_hair').nextElementSibling).toHaveTextContent('长发')
    expect(screen.getByText('white shirt').nextElementSibling).toHaveTextContent('白衬衫 白上衣')
    expect(screen.getByText('unknown').nextElementSibling).toHaveTextContent('-')
  })

  it('keeps the translation preference authoritative in stacked mode', () => {
    __setStateForTest({ status: 'ready', entries: new Map([['long hair', ['长发']]]) })
    __setTagPrefsForTest({ loaded: true, showTranslation: false })
    render(<TagEditor tags={['long hair', 'unknown']} onChange={() => {}} />)

    expect(screen.queryByText('长发')).not.toBeInTheDocument()
    expect(screen.queryByText('-')).not.toBeInTheDocument()
    expect(screen.getByText('long hair').nextElementSibling).toBeNull()
  })

  it('cycles five reference tones by the current list position', () => {
    const tags = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const { container } = render(<TagEditor tags={tags} onChange={() => {}} />)
    const chips = Array.from(container.querySelectorAll<HTMLElement>('[data-tag-chip]'))

    expect(chips).toHaveLength(8)
    expect(chips.map((chip) => chip.dataset.tagToneIndex)).toEqual([
      '0', '1', '2', '3', '4', '0', '1', '2',
    ])
    expect(chips[0].style.getPropertyValue('--tag-tone')).toBe(TAG_TONES[0])
    expect(chips[5].style.getPropertyValue('--tag-tone')).toBe(TAG_TONES[0])
    expect(chips[0]).toHaveClass('rounded-[5px]', 'py-1.5')
    expect(chips[0].parentElement).toHaveClass('gap-2')
  })

  it('calculates insertions without mutating the live order', () => {
    const order = ['a', 'b', 'c', 'd']
    expect(reorderTagFlow(order, 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c'])
    expect(reorderTagFlow(order, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd'])
    expect(reorderTagFlow(order, 'b', 'a', 'after')).toBe(order)
    expect(order).toEqual(['a', 'b', 'c', 'd'])
  })

  it('requires the dragged centre to cross a neighbouring tag centre in the same row', () => {
    const order = ['a', 'b', 'c']
    const rects = new Map([
      ['a', rect(10, 10, 80, 40)],
      ['b', rect(100, 10, 80, 40)],
      ['c', rect(190, 10, 80, 40)],
    ])
    const listRect = rect(0, 0, 400, 160)

    expect(resolveTagCenterDrop(order, 'a', rect(99, 10, 80, 40), listRect, rects)).toBeNull()
    expect(resolveTagCenterDrop(order, 'a', rect(101, 10, 80, 40), listRect, rects)).toEqual({
      id: 'c', edge: 'before',
    })
    expect(resolveTagCenterDrop(order, 'c', rect(101, 10, 80, 40), listRect, rects)).toBeNull()
    expect(resolveTagCenterDrop(order, 'c', rect(99, 10, 80, 40), listRect, rects)).toEqual({
      id: 'b', edge: 'before',
    })
  })

  it('requires the dragged centre to cross another visual row centre before moving rows', () => {
    const order = ['a', 'b', 'c', 'd', 'e']
    const rects = new Map([
      ['a', rect(10, 10, 80, 40)],
      ['b', rect(100, 10, 80, 40)],
      ['c', rect(190, 10, 80, 40)],
      ['d', rect(10, 60, 80, 40)],
      ['e', rect(100, 60, 80, 40)],
    ])
    const listRect = rect(0, 0, 400, 160)

    expect(resolveTagCenterDrop(order, 'b', rect(11, 39, 80, 40), listRect, rects)).toBeNull()
    expect(resolveTagCenterDrop(order, 'b', rect(11, 61, 80, 40), listRect, rects)).toEqual({
      id: 'e', edge: 'before',
    })
  })

  it('fails closed for incomplete geometry or when the dragged centre leaves the list', () => {
    const order = ['a', 'b']
    const listRect = rect(0, 0, 240, 100)
    const rects = new Map([
      ['a', rect(10, 10, 80, 40)],
      ['b', rect(100, 10, 80, 40)],
    ])

    expect(resolveTagCenterDrop(order, 'a', rect(101, 10, 80, 40), listRect, new Map([
      ['a', rect(10, 10, 80, 40)],
    ]))).toBeNull()
    expect(resolveTagCenterDrop(order, 'a', rect(241, 10, 80, 40), listRect, rects)).toBeNull()
    expect(resolveTagCenterDrop(['a'], 'a', rect(10, 10, 80, 40), listRect, new Map([
      ['a', rect(10, 10, 80, 40)],
    ]))).toBeNull()
  })

  it('can delegate the tag count to a parent panel header', () => {
    render(<TagEditor tags={['a', 'b']} onChange={() => {}} showTagCount={false} />)
    expect(screen.queryByText('2 个标签')).not.toBeInTheDocument()
  })

  it('updates the parent cache immediately in text mode without a sync action', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<TagEditor tags={['a']} onChange={onChange} />)

    await user.click(screen.getByText('文本'))
    fireEvent.change(screen.getByRole('textbox', { name: '以文本编辑标签' }), {
      target: { value: 'a, b,\na' },
    })

    expect(onChange).toHaveBeenLastCalledWith(['a', 'b'], expect.any(Set))
    expect(Array.from(
      onChange.mock.calls[onChange.mock.calls.length - 1]?.[1] as Set<string>,
    )).toEqual([])
    expect(screen.queryByRole('button', { name: '同步' })).not.toBeInTheDocument()
  })

  it('keeps free-form text intact while the parent cache echoes parsed tags', async () => {
    const user = userEvent.setup()
    function ControlledEditor() {
      const [tags, setTags] = useState(['a'])
      return <TagEditor tags={tags} onChange={setTags} />
    }
    render(<ControlledEditor />)

    await user.click(screen.getByText('文本'))
    const input = screen.getByRole('textbox', { name: '以文本编辑标签' })
    fireEvent.change(input, { target: { value: 'a, b,\na' } })

    expect(input).toHaveValue('a, b,\na')
  })

  it('resets the text buffer on source or external tag changes without resetting mode', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <TagEditor resetKey="image-a" tags={['a']} onChange={() => {}} />,
    )
    await user.click(screen.getByText('文本'))
    const input = screen.getByRole('textbox', { name: '以文本编辑标签' })
    fireEvent.change(input, { target: { value: 'a,\n' } })
    expect(input).toHaveValue('a,\n')

    rerender(<TagEditor resetKey="image-b" tags={['a']} onChange={() => {}} />)
    expect(input).toHaveValue('a')
    expect(screen.getByRole('radio', { name: '文本' })).toBeChecked()

    rerender(<TagEditor resetKey="image-b" tags={['different']} onChange={() => {}} />)
    expect(input).toHaveValue('different')
    expect(screen.getByRole('radio', { name: '文本' })).toBeChecked()
  })

  it('Enter adds a tag at the end (chip 拖拽心智 — 新东西落底部)', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<TagEditor tags={['a']} onChange={onChange} />)
    const input = screen.getByPlaceholderText(/添加标签/)
    await user.type(input, 'new{Enter}')
    expect(onChange).toHaveBeenCalledWith(['a', 'new'], expect.any(Set))
  })

  it('comma also adds a tag', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<TagEditor tags={[]} onChange={onChange} />)
    await user.type(screen.getByPlaceholderText(/添加标签/), 'foo,')
    expect(onChange).toHaveBeenCalledWith(['foo'], expect.any(Set))
  })

  it('clicking a chip toggles it between selected colour and inactive grey', async () => {
    const user = userEvent.setup()
    function ControlledEditor() {
      const [tags, setTags] = useState(['a', 'b'])
      const [inactive, setInactive] = useState<Set<string>>(new Set())
      return (
        <TagEditor
          tags={tags}
          inactiveTags={inactive}
          onChange={(nextTags, nextInactive) => {
            setTags(nextTags)
            setInactive(new Set(nextInactive))
          }}
        />
      )
    }
    const { container } = render(<ControlledEditor />)
    const chip = container.querySelector<HTMLButtonElement>('[data-tag-chip="a"]')!
    expect(chip).toHaveAttribute('aria-pressed', 'true')

    await user.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    expect(chip).toHaveAttribute('data-tag-inactive', 'true')
    expect(chip.style.color).toBe('var(--tag-inactive-fg)')
    expect(chip.style.backgroundColor).toBe('var(--tag-inactive-bg)')
    expect(chip.style.borderColor).toBe('var(--tag-inactive-border)')
    expect(screen.getByText('1 个标签')).toBeInTheDocument()

    await user.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    expect(chip).toHaveAttribute('data-tag-inactive', 'false')
    expect(screen.getByText('2 个标签')).toBeInTheDocument()
  })

  it('reactivates an inactive duplicate from the add input without adding another chip', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { container } = render(
      <TagEditor tags={['a', 'b']} inactiveTags={new Set(['b'])} onChange={onChange} />,
    )
    await user.type(screen.getByPlaceholderText(/添加标签/), 'b{Enter}')

    expect(onChange).toHaveBeenCalledWith(['a', 'b'], expect.any(Set))
    expect(Array.from(
      onChange.mock.calls[onChange.mock.calls.length - 1]?.[1] as Set<string>,
    )).toEqual([])
    expect(container.querySelectorAll('[data-tag-chip="b"]')).toHaveLength(1)
  })

  it('shows only selected tags in text mode and retains omitted tags as inactive chips', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(
      <TagEditor tags={['a', 'b', 'c']} inactiveTags={new Set(['b'])} onChange={onChange} />,
    )
    await user.click(screen.getByText('文本'))
    const input = screen.getByRole('textbox', { name: '以文本编辑标签' })
    expect(input).toHaveValue('a, c')

    fireEvent.change(input, { target: { value: 'c, b' } })
    expect(onChange).toHaveBeenLastCalledWith(['c', 'b', 'a'], expect.any(Set))
    expect(Array.from(
      onChange.mock.calls[onChange.mock.calls.length - 1]?.[1] as Set<string>,
    )).toEqual(['a'])

    rerender(
      <TagEditor tags={['c', 'b', 'a']} inactiveTags={new Set(['a'])} onChange={onChange} />,
    )
    expect(input).toHaveValue('c, b')
  })

  it('refuses duplicates silently', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<TagEditor tags={['a']} onChange={onChange} />)
    await user.type(screen.getByPlaceholderText(/添加标签/), 'a{Enter}')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('natural mode renders textarea', () => {
    render(<TagEditor natural tags={['a long sentence']} onChange={() => {}} />)
    expect(
      screen.getByPlaceholderText(/自然语言/)
    ).toBeInTheDocument()
  })

  // Keep this last: dnd-kit installs a one-shot post-drag click guard. A real
  // browser emits that click automatically, while this synthetic sequence does
  // not, so running more click-driven cases afterwards would be misleading.
  it('keeps the DOM still during drag, marks the gap, then commits once on drop', async () => {
    const onChange = vi.fn()
    const { container } = render(
      <TagEditor tags={['a', 'b', 'c']} inactiveTags={new Set(['a'])} onChange={onChange} />,
    )
    const list = container.querySelector('[data-tag-chip]')!.parentElement!
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 160))
    const chips = Array.from(container.querySelectorAll<HTMLElement>('[data-tag-chip]'))
    chips.forEach((chip, index) => {
      vi.spyOn(chip, 'getBoundingClientRect').mockReturnValue(rect(10 + index * 90, 10, 80, 40))
    })

    fireEvent.pointerDown(chips[0], {
      button: 0, buttons: 1, clientX: 20, clientY: 20, pointerId: 1, isPrimary: true,
    })
    fireEvent.pointerMove(document, {
      button: 0, buttons: 1, clientX: 30, clientY: 20, pointerId: 1, isPrimary: true,
    })
    expect(container.querySelector('[data-tag-insertion-edge]')).not.toBeInTheDocument()
    fireEvent.pointerMove(document, {
      button: 0, buttons: 1, clientX: 109, clientY: 20, pointerId: 1, isPrimary: true,
    })
    expect(container.querySelector('[data-tag-insertion-edge]')).not.toBeInTheDocument()
    fireEvent.pointerMove(document, {
      button: 0, buttons: 1, clientX: 111, clientY: 20, pointerId: 1, isPrimary: true,
    })

    await waitFor(() => {
      expect(container.querySelector('[data-tag-insertion-edge="before"]')).toBeInTheDocument()
    })
    const insertionMarker = container.querySelector('[data-tag-insertion-edge="before"]')
    expect(insertionMarker).toHaveClass('w-1', '-left-[6px]')
    expect(insertionMarker).not.toHaveClass('w-0.5', '-left-[3px]')
    expect(Array.from(container.querySelectorAll('[data-tag-chip]'), (chip) => (
      chip.getAttribute('data-tag-chip')
    ))).toEqual(['a', 'b', 'c'])
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.pointerMove(document, {
      button: 0, buttons: 1, clientX: 109, clientY: 20, pointerId: 1, isPrimary: true,
    })
    await waitFor(() => {
      expect(container.querySelector('[data-tag-insertion-edge]')).not.toBeInTheDocument()
    })
    fireEvent.pointerMove(document, {
      button: 0, buttons: 1, clientX: 201, clientY: 20, pointerId: 1, isPrimary: true,
    })
    await waitFor(() => {
      expect(container.querySelector('[data-tag-insertion-edge="after"]')).toBeInTheDocument()
    })
    fireEvent.pointerUp(document, {
      button: 0, clientX: 201, clientY: 20, pointerId: 1, isPrimary: true,
    })
    // The click synthesized from the same pointer gesture must not reactivate
    // the inactive chip after the reorder completes.
    fireEvent.click(chips[0])
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(
      ['b', 'c', 'a'],
      expect.any(Set),
    ))
    expect(Array.from(
      onChange.mock.calls[onChange.mock.calls.length - 1]?.[1] as Set<string>,
    )).toEqual(['a'])
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
