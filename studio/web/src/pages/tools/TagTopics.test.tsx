import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import seed from '../../../../data/tag_topics.json'
import TagTopicsPage from './TagTopics'
import { topicRequest } from '../../tagDict/topics'
import { DialogProvider } from '../../components/Dialog'

vi.mock('../../tagDict/topics', async (original) => {
  const actual = await original<typeof import('../../tagDict/topics')>()
  const snapshot = { ...seed, revision: 1, entries: Object.fromEntries(seed.entries.map((entry) => [entry.tag, { ...entry, source: 'builtin' }])) }
  return { ...actual, reloadTopics: vi.fn(async () => undefined), topicRequest: vi.fn(),
    useTagTopics: () => ({ loading: false, error: null, snapshot }) }
})
const entries = seed.entries.filter((entry) => entry.topic === 'ponytail')
const rows = entries.map((entry) => ({ tag: entry.tag, zh: '', topic: entry.topic, source: 'builtin', reason: entry.relation, entry }))
const mount = () => render(<DialogProvider><TagTopicsPage /></DialogProvider>)
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(topicRequest).mockImplementation(async (path) => {
    if (path.startsWith('/entries?')) {
      const params = new URLSearchParams(path.split('?')[1])
      return { items: params.get('q') === 'missing' || Number(params.get('offset')) > 0 ? [] : rows, total: 20 } as never
    }
    return {} as never
  })
})

describe('topic library card workspace', () => {
  it('previews without losing duplicate text and saves only explicit overrides in the drawer', async () => {
    const user = userEvent.setup()
    mount()
    fireEvent.change(screen.getByRole('textbox', { name: '预览提示词' }), { target: { value: 'large breasts, blue eyes, chest, blue eyes' } })
    expect([...screen.getByTestId('organized-preview').children].map((node) => node.textContent)).toEqual(['chest', 'large breasts', 'blue eyes', 'blue eyes'])
    await user.click(screen.getByRole('button', { name: '新增词条' }))
    const drawer = await screen.findByRole('dialog', { name: '词条详情与修正' })
    fireEvent.change(within(drawer).getByRole('textbox', { name: '英文标签' }), { target: { value: 'custom chest' } })
    fireEvent.change(within(drawer).getByRole('combobox', { name: '词条主题' }), { target: { value: 'chest' } })
    expect(vi.mocked(topicRequest).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0)
    await user.click(within(drawer).getByRole('button', { name: '保存修正' }))
    await waitFor(() => expect(topicRequest).toHaveBeenCalledWith('/entries', expect.objectContaining({ method: 'PUT', body: expect.stringContaining('custom chest') })))
    expect(drawer).toBeInTheDocument()
    expect(within(drawer).getByRole('textbox', { name: '英文标签' })).toHaveValue('custom chest')
    expect(within(drawer).getByText('已保存修正，下次整理生效')).toBeInTheDocument()
  })
  it('only selects cards, requests 12 rows, and clears selection when filtering it out', async () => {
    const user = userEvent.setup()
    mount()
    const card = await screen.findByRole('button', { name: '选择词条 ponytail' })
    expect(card).toHaveAttribute('aria-pressed', 'false')
    await user.click(card)
    expect(card).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('region', { name: '选中词条详情' })).toHaveTextContent('ponytail')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(vi.mocked(topicRequest).mock.calls[0][0]).toContain('limit=12')
    fireEvent.change(screen.getByRole('textbox', { name: '搜索主题词库' }), { target: { value: 'missing' } })
    await screen.findByText('没有匹配的词条')
    expect(screen.queryByRole('region', { name: '选中词条详情' })).not.toBeInTheDocument()
  })
  it('keeps a failed draft and asks before discarding it', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(await screen.findByRole('button', { name: '编辑词条 ponytail' }))
    const drawer = await screen.findByRole('dialog', { name: '词条详情与修正' })
    fireEvent.change(within(drawer).getByRole('textbox', { name: '来源或修正说明' }), { target: { value: 'unsaved note' } })
    vi.mocked(topicRequest).mockRejectedValueOnce(new Error('save failed'))
    await user.click(within(drawer).getByRole('button', { name: '保存修正' }))
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('save failed')
    await user.click(within(drawer).getByRole('button', { name: '关闭编辑抽屉' }))
    await user.click(await screen.findByRole('button', { name: '继续编辑' }))
    expect(within(drawer).getByRole('textbox', { name: '来源或修正说明' })).toHaveValue('unsaved note')
    await user.click(within(drawer).getByRole('button', { name: '关闭编辑抽屉' }))
    await user.click(await screen.findByRole('button', { name: '放弃修改' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '词条详情与修正' })).not.toBeInTheDocument())
  })
  it('uses stable colors on filtering and paginates in 12-item increments', async () => {
    const user = userEvent.setup()
    mount()
    const card = await screen.findByRole('button', { name: '选择词条 ponytail' })
    const tone = card.closest('article')!.style.getPropertyValue('--tag-tone')
    fireEvent.change(screen.getByRole('textbox', { name: '搜索主题词库' }), { target: { value: 'ponytail' } })
    await waitFor(() => expect(topicRequest).toHaveBeenCalledWith(expect.stringContaining('q=ponytail'), expect.anything()))
    expect(screen.getByRole('button', { name: '选择词条 ponytail' }).closest('article')!.style.getPropertyValue('--tag-tone')).toBe(tone)
    await user.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(topicRequest).toHaveBeenCalledWith(expect.stringContaining('offset=12'), expect.anything()))
  })
})
