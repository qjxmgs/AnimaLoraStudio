import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TagStatsPanel from './TagStatsPanel'

const cache = new Map([['a', ['cat', 'cat', 'dog']], ['b', ['dog']]])
const props = { cache, selectedKeys: ['a', 'b'], onPickTag: vi.fn(), onToggleTag: vi.fn() }
beforeEach(() => { localStorage.clear(); vi.clearAllMocks() })
describe('TagStatsPanel view modes', () => {
  it('defaults to list, remembers grid across mounts, and falls back for invalid values', () => {
    const first = render(<TagStatsPanel {...props} />)
    expect(screen.getByRole('button', { name: '切换列表显示' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '切换网格显示' }))
    expect(localStorage.getItem('studio:tag-stats:view')).toBe('"grid"')
    first.unmount()
    const second = render(<TagStatsPanel {...props} selectedKeys={['b']} />)
    expect(screen.getByTestId('tag-stats-grid')).toBeInTheDocument()
    second.unmount()
    localStorage.setItem('studio:tag-stats:view', '"invalid"')
    render(<TagStatsPanel {...props} />)
    expect(screen.queryByTestId('tag-stats-grid')).not.toBeInTheDocument()
  })
  it('shares filter and sorting and counts each image once', () => {
    render(<TagStatsPanel {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '切换网格显示' }))
    const tags = () => within(screen.getByTestId('tag-stats-grid')).getAllByRole('button')
    expect(tags().map((el) => el.dataset.statsTag)).toEqual(['dog', 'cat'])
    expect(screen.getByRole('button', { name: '关闭「cat」' })).toHaveTextContent('1')
    fireEvent.click(screen.getByRole('button', { name: '名称' }))
    expect(tags().map((el) => el.dataset.statsTag)).toEqual(['cat', 'dog'])
    fireEvent.change(screen.getByRole('textbox', { name: '筛选选中图片的标签' }), { target: { value: 'cat' } })
    fireEvent.click(screen.getByRole('button', { name: '切换列表显示' }))
    expect(screen.getByRole('textbox')).toHaveValue('cat')
    fireEvent.click(screen.getByRole('button', { name: '切换网格显示' }))
    expect(tags()).toHaveLength(1)
    fireEvent.click(tags()[0])
    expect(props.onToggleTag).toHaveBeenCalledWith('cat')
    expect(props.onPickTag).not.toHaveBeenCalled()
  })
  it('retains disabled tags and represents mixed state without changing list behavior', () => {
    localStorage.setItem('studio:tag-stats:view', '"grid"')
    render(<TagStatsPanel {...props} inactiveDrafts={new Map([
      ['b', { order: ['cat', 'dog', 'bird'], inactive: ['cat', 'bird'] }],
    ])} />)
    expect(screen.getByRole('button', { name: '关闭「cat」' })).toHaveAttribute('aria-pressed', 'mixed')
    expect(screen.getByRole('button', { name: '关闭「cat」' })).toHaveTextContent('1/2')
    expect(screen.getByRole('button', { name: '开启「bird」' })).toHaveTextContent('0/1')
    fireEvent.click(screen.getByRole('button', { name: '切换列表显示' }))
    expect(screen.queryByText('bird')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'cat' }))
    expect(props.onPickTag).toHaveBeenCalledWith('cat')
  })
})
