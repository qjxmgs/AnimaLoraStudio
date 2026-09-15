import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import ProjectCustomTags from './ProjectCustomTags'

describe('ProjectCustomTags', () => {
  it('uses a neutral three-row palette and disables tags already on the image', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(
      <ProjectCustomTags
        tags={['already', 'available']}
        activeTags={new Set(['already'])}
        onPick={onPick}
        onAdd={() => {}}
        onDelete={() => {}}
      />,
    )

    const palette = screen.getByRole('region', { name: '项目常驻标签' })
    expect(palette).toHaveClass('max-h-36')
    const header = palette.querySelector('[data-custom-tags-header]')
    expect(header).toHaveClass('h-10', 'shrink-0')
    expect(header).toHaveTextContent('自定义快捷标签')
    expect(header).toContainElement(
      within(palette).getByRole('button', { name: '添加项目常驻标签' }),
    )
    expect(within(palette).getByRole('button', { name: /^already$/ })).toHaveClass(
      'bg-transparent',
    )
    expect(within(palette).getByRole('button', { name: /^already$/ })).toBeDisabled()
    const available = within(palette).getByRole('button', { name: /^available$/ })
    expect(available).toBeEnabled()
    expect(available.parentElement).toHaveClass('border-info', 'bg-info-soft', 'text-info')
    await user.click(available)
    expect(onPick).toHaveBeenCalledWith('available')
  })

  it('adds one normalized tag inline and blocks exact duplicates', async () => {
    const user = userEvent.setup()
    const onAdd = vi.fn()
    render(
      <ProjectCustomTags
        tags={['solo']}
        activeTags={new Set()}
        onPick={() => {}}
        onAdd={onAdd}
        onDelete={() => {}}
      />,
    )

    await user.click(screen.getByRole('button', { name: '添加项目常驻标签' }))
    const input = screen.getByRole('textbox', { name: '输入新的项目常驻标签' })
    await user.type(input, 'solo')
    expect(screen.getByRole('button', { name: '确认添加常驻标签' })).toBeDisabled()
    expect(input).toHaveAttribute('aria-invalid', 'true')

    await user.clear(input)
    await user.type(input, '  rabbit ears  {Enter}')
    expect(onAdd).toHaveBeenCalledWith('rabbit ears')
    expect(screen.queryByRole('textbox', { name: '输入新的项目常驻标签' })).not.toBeInTheDocument()
  })

  it('requires a second delete click and resets the armed tag on other actions', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    render(
      <ProjectCustomTags
        tags={['alpha', 'beta']}
        activeTags={new Set()}
        onPick={() => {}}
        onAdd={() => {}}
        onDelete={onDelete}
      />,
    )

    await user.click(screen.getByRole('button', { name: '删除常驻标签 alpha' }))
    expect(screen.getByRole('button', { name: '再次点击删除常驻标签 alpha' })).toHaveTextContent('!')
    expect(onDelete).not.toHaveBeenCalled()

    await user.click(document.body)
    expect(screen.getByRole('button', { name: '删除常驻标签 alpha' })).toHaveTextContent('×')

    await user.click(screen.getByRole('button', { name: '删除常驻标签 alpha' }))
    await user.click(screen.getByRole('button', { name: '删除常驻标签 beta' }))
    expect(screen.getByRole('button', { name: '删除常驻标签 alpha' })).toHaveTextContent('×')
    expect(screen.getByRole('button', { name: '再次点击删除常驻标签 beta' })).toHaveTextContent('!')

    await user.click(screen.getByRole('button', { name: '再次点击删除常驻标签 beta' }))
    expect(onDelete).toHaveBeenCalledWith('beta')
  })

  it('cancels delete confirmation and inline input with Escape', async () => {
    const user = userEvent.setup()
    render(
      <ProjectCustomTags
        tags={['alpha']}
        activeTags={new Set()}
        onPick={() => {}}
        onAdd={() => {}}
        onDelete={() => {}}
      />,
    )

    await user.click(screen.getByRole('button', { name: '删除常驻标签 alpha' }))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: '删除常驻标签 alpha' })).toHaveTextContent('×')

    await user.click(screen.getByRole('button', { name: '添加项目常驻标签' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: '输入新的项目常驻标签' })).not.toBeInTheDocument()
  })
})
