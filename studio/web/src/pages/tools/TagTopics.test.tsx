import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import seed from '../../../../data/tag_topics.json'
import TagTopicsPage from './TagTopics'
import { topicRequest } from '../../tagDict/topics'

vi.mock('../../tagDict/topics', async (original) => {
  const actual = await original<typeof import('../../tagDict/topics')>()
  return { ...actual, reloadTopics: vi.fn(async () => undefined), topicRequest: vi.fn(async () => ({ items: [], total: 0 })),
    useTagTopics: () => ({ loading: false, error: null, snapshot: { ...seed, revision: 1, entries: Object.fromEntries(seed.entries.map((entry) => [entry.tag, { ...entry, source: 'builtin' }])) } }) }
})

describe('topic library workspace', () => {
  it('previews semantic sorting and saves only explicit user overrides', async () => {
    render(<TagTopicsPage />)
    fireEvent.change(screen.getByRole('textbox', { name: '预览提示词' }), { target: { value: 'large breasts, blue eyes, chest' } })
    expect(screen.getByTestId('organized-preview')).toHaveTextContent('chest, large breasts, blue eyes')
    fireEvent.click(screen.getByRole('button', { name: '新增词条' }))
    fireEvent.change(screen.getByRole('textbox', { name: '英文标签' }), { target: { value: 'custom chest' } })
    fireEvent.change(screen.getByRole('combobox', { name: '词条主题' }), { target: { value: 'chest' } })
    expect(vi.mocked(topicRequest).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '保存修正' }))
    await waitFor(() => expect(topicRequest).toHaveBeenCalledWith('/entries', expect.objectContaining({ method: 'PUT', body: expect.stringContaining('custom chest') })))
    expect(await screen.findByText('已保存修正，下次整理生效')).toBeInTheDocument()
  })
})
