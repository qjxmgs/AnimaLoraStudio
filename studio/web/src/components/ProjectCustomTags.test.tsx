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
        onReplace={() => {}}
      />,
    )

    const palette = screen.getByRole('region', { name: '项目常驻标签' })
    expect(palette).toHaveClass('max-h-[33.333333%]')
    expect(palette).not.toHaveClass('basis-1/3')
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
        onReplace={() => {}}
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
        onReplace={() => {}}
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
        onReplace={() => {}}
      />,
    )

    await user.click(screen.getByRole('button', { name: '删除常驻标签 alpha' }))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: '删除常驻标签 alpha' })).toHaveTextContent('×')

    await user.click(screen.getByRole('button', { name: '添加项目常驻标签' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: '输入新的项目常驻标签' })).not.toBeInTheDocument()
  })

  it('edits all quick tags as newline text and create exits text mode', async () => {
    const user = userEvent.setup()
    const onReplace = vi.fn()
    render(
      <ProjectCustomTags
        tags={['alpha', 'tag, with comma']}
        activeTags={new Set()}
        onPick={() => {}}
        onAdd={() => {}}
        onDelete={() => {}}
        onReplace={onReplace}
      />,
    )

    const textMode = screen.getByRole('button', { name: '以文本编辑自定义快捷标签' })
    await user.click(textMode)
    expect(textMode).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('region', { name: '项目常驻标签' })).toHaveClass(
      'min-h-0',
      'max-h-[33.333333%]',
      'basis-1/3',
    )
    expect(screen.getByRole('textbox', { name: '文本编辑自定义快捷标签' })).toBeInTheDocument()
    await user.click(textMode)
    expect(textMode).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('region', { name: '项目常驻标签' })).toHaveClass('max-h-[33.333333%]')
    expect(screen.getByRole('region', { name: '项目常驻标签' })).not.toHaveClass('basis-1/3')
    expect(screen.queryByRole('textbox', { name: '文本编辑自定义快捷标签' })).not.toBeInTheDocument()

    await user.click(textMode)
    const textarea = screen.getByRole('textbox', { name: '文本编辑自定义快捷标签' })
    expect(textarea).toHaveValue('alpha\ntag, with comma')

    await user.clear(textarea)
    await user.type(textarea, 'alpha{Enter}gamma{Enter}alpha')
    await user.click(screen.getByRole('button', { name: '添加项目常驻标签' }))

    expect(onReplace).toHaveBeenCalledWith(['alpha', 'gamma'])
    expect(screen.queryByRole('button', { name: '以文本编辑自定义快捷标签' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '文本编辑自定义快捷标签' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '输入新的项目常驻标签' })).toBeInTheDocument()
  })
})
