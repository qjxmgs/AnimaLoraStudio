import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type CropWorkspaceItem } from '../../api/client'
import SingleImageInpaintDialog from './SingleImageInpaintDialog'

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  toast: vi.fn(),
  resetStrokeAnchor: vi.fn(),
}))

vi.mock('../Dialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../Dialog')>()
  return { ...actual, useDialog: () => ({ confirm: mocks.confirm }) }
})

vi.mock('../Toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../Toast')>()
  return { ...actual, useToast: () => ({ toast: mocks.toast }) }
})

vi.mock('./InpaintCanvas', async () => {
  const React = await import('react')
  const { createPortal } = await import('react-dom')
  const Canvas = React.forwardRef(function Canvas(
    props: {
      mode: 'paint' | 'mask'
      tool: 'brush' | 'eraser' | 'lasso'
      paintEdits: object[]
      maskEdits: object[]
      onStrokeEnd: (stroke: object) => void
      onMaskStrokeEnd: (stroke: object) => void
      statusBarPortalTarget?: HTMLElement | null
    },
    ref: React.ForwardedRef<{
      exportBlob: () => Promise<Blob | null>
      exportMaskBlob: () => Promise<{ blob: Blob; coverage: number } | null>
      cancelTransientEdit: () => boolean
      resetStrokeAnchor: () => void
    }>,
  ) {
    React.useImperativeHandle(ref, () => ({
      exportBlob: async () => new Blob(['paint']),
      exportMaskBlob: async () => ({ blob: new Blob(['mask']), coverage: 0.2 }),
      cancelTransientEdit: () => false,
      resetStrokeAnchor: mocks.resetStrokeAnchor,
    }))
    const stroke = {
      color: '#ffffff', size: 24, hardness: 1, points: [{ x: 5, y: 5 }],
    }
    const canvas = (
      <div data-testid="dialog-inpaint-canvas" data-mode={props.mode} data-tool={props.tool}>
        <span>paint:{props.paintEdits.length} mask:{props.maskEdits.length}</span>
        <button
          type="button"
          onClick={() => props.mode === 'mask'
            ? props.onMaskStrokeEnd(stroke)
            : props.onStrokeEnd(stroke)}
        >
          Draw test stroke
        </button>
      </div>
    )
    return (
      <>
        {canvas}
        {props.statusBarPortalTarget
          ? createPortal(
              <div data-testid="inpaint-canvas-status">Canvas status</div>,
              props.statusBarPortalTarget,
            )
          : null}
      </>
    )
  })
  return {
    default: Canvas,
    renderInpaintedBlob: vi.fn(),
    renderMaskBlob: vi.fn(),
  }
})

const image: CropWorkspaceItem = {
  name: '1_data/a.jpg',
  source: 'a.jpg',
  w: 640,
  h: 480,
  mtime: 1,
  size: 10,
  processed: false,
  mask_mtime: 3,
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  mocks.confirm.mockReset()
  mocks.confirm.mockResolvedValue(true)
  localStorage.clear()
  vi.spyOn(api, 'saveInpaintTrain').mockResolvedValue({
    name: '1_data/a.png', origin: 'a.jpg', w: 640, h: 480,
    mtime: 10, size: 20,
  })
  vi.spyOn(api, 'saveMaskTrain').mockResolvedValue({
    name: '1_data/a.png', mtime: 11, size: 4,
  })
  vi.spyOn(api, 'deleteMaskTrain').mockResolvedValue({ deleted: true })
})

describe('SingleImageInpaintDialog', () => {
  it('focuses the inert editor surface instead of arming the close button with Space', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <SingleImageInpaintDialog
        projectId={7}
        versionId={11}
        image={image}
        onClose={onClose}
      />,
    )

    const editorRoot = screen.getByTestId('single-image-inpaint-editor-root')
    const close = screen.getByRole('button', { name: '关闭' })
    await waitFor(() => expect(editorRoot).toHaveFocus())
    expect(close).not.toHaveFocus()

    await user.keyboard('{Space>}')
    expect(close).not.toHaveFocus()
    await user.keyboard('{/Space}')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows only the reusable single-image editing controls', () => {
    render(
      <SingleImageInpaintDialog
        projectId={7}
        versionId={11}
        image={image}
        onClose={() => {}}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: '单图涂抹' })
    expect(dialog).toHaveAccessibleDescription('1_data/a.jpg · 640×480')
    expect(within(dialog).getByRole('radiogroup', { name: '模式' })).toBeInTheDocument()
    expect(within(dialog).getByRole('radiogroup', { name: '工具' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '保存并关闭' })).toBeDisabled()
    expect(within(dialog).queryByText(/保存全部/)).not.toBeInTheDocument()
    expect(within(dialog).queryByText('自动头部遮罩')).not.toBeInTheDocument()
    const header = dialog.querySelector('header')
    expect(header).not.toBeNull()
    const title = within(header as HTMLElement).getByRole('heading', { name: '单图涂抹' })
    const imageTitle = within(header as HTMLElement).getByText('1_data/a.jpg · 640×480')
    expect(title.parentElement).toContainElement(imageTitle)
    expect(title.parentElement).toHaveClass('items-baseline')
    expect(imageTitle).toHaveClass('truncate', 'font-mono')
    expect(imageTitle.parentElement?.parentElement?.children).toHaveLength(1)
    const historyActions = within(header as HTMLElement).getByTestId(
      'single-image-inpaint-history-actions',
    )
    expect(within(historyActions).getByRole('button', { name: '撤销' })).toBeDisabled()
    expect(within(historyActions).getByRole('button', { name: '重做' })).toBeDisabled()
    expect(within(historyActions).getByRole('button', { name: '放弃当前修改' })).toBeDisabled()
    const close = within(header as HTMLElement).getByRole('button', { name: '关闭' })
    expect(close).toHaveClass('btn-sm', '-mr-4', '-mt-4')
    expect(close.querySelector('svg')).toHaveAttribute('width', '18')
    expect(historyActions.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()

    const editorRoot = within(dialog).getByTestId('single-image-inpaint-editor-root')
    expect(editorRoot.parentElement).toHaveClass('!pt-2', '!pb-2')
    const main = within(dialog).getByTestId('single-image-inpaint-main')
    const statusHost = within(dialog).getByTestId('single-image-inpaint-status-host')
    const status = within(dialog).getByTestId('inpaint-canvas-status')
    const toolFooter = within(dialog).getByTestId('inpaint-tool-panel-footer')
    const toolScroll = within(dialog).getByTestId('inpaint-tool-panel-scroll')
    expect(main).toHaveClass('grid', 'flex-1')
    expect(main.previousElementSibling).toBeNull()
    expect(main).not.toContainElement(status)
    expect(statusHost).toContainElement(status)
    expect(main.nextElementSibling).toBe(statusHost)
    expect(toolFooter).toContainElement(within(dialog).getByRole('button', { name: '取消' }))
    expect(toolFooter).toContainElement(within(dialog).getByRole('button', { name: '保存并关闭' }))
    expect(toolScroll).not.toContainElement(toolFooter)
    expect(dialog.querySelector('footer')).toBeNull()
  })

  it('keeps history actions working after moving them into the header', async () => {
    const user = userEvent.setup()
    render(
      <SingleImageInpaintDialog
        projectId={7}
        versionId={11}
        image={image}
        onClose={() => {}}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Draw test stroke' }))
    expect(screen.getByTestId('dialog-inpaint-canvas')).toHaveTextContent('paint:1 mask:0')

    await user.click(screen.getByRole('button', { name: '撤销' }))
    expect(screen.getByTestId('dialog-inpaint-canvas')).toHaveTextContent('paint:0 mask:0')

    await user.click(screen.getByRole('button', { name: '重做' }))
    expect(screen.getByTestId('dialog-inpaint-canvas')).toHaveTextContent('paint:1 mask:0')

    await user.click(screen.getByRole('button', { name: '放弃当前修改' }))
    expect(screen.getByTestId('dialog-inpaint-canvas')).toHaveTextContent('paint:0 mask:0')
    expect(mocks.resetStrokeAnchor).toHaveBeenCalledTimes(3)
  })

  it('saves paint and mask in order, then closes', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onStageSaved = vi.fn()
    render(
      <SingleImageInpaintDialog
        projectId={7}
        versionId={11}
        image={image}
        onClose={onClose}
        onStageSaved={onStageSaved}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Draw test stroke' }))
    await user.click(screen.getByRole('radio', { name: '训练遮罩' }))
    await user.click(screen.getByRole('button', { name: 'Draw test stroke' }))
    await user.click(screen.getByRole('button', { name: '保存并关闭' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(api.saveInpaintTrain).toHaveBeenCalledWith(7, 11, '1_data/a.jpg', expect.any(Blob))
    expect(api.saveMaskTrain).toHaveBeenCalledWith(7, 11, '1_data/a.png', expect.any(Blob))
    expect(onStageSaved.mock.calls.map(([stage]) => stage.kind)).toEqual(['paint', 'mask'])
  })

  it('keeps only the failed data surface pending for retry', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onStageSaved = vi.fn()
    vi.mocked(api.saveMaskTrain).mockRejectedValueOnce(new Error('mask offline'))
    render(
      <SingleImageInpaintDialog
        projectId={7}
        versionId={11}
        image={image}
        onClose={onClose}
        onStageSaved={onStageSaved}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Draw test stroke' }))
    await user.click(screen.getByRole('radio', { name: '训练遮罩' }))
    await user.click(screen.getByRole('button', { name: 'Draw test stroke' }))
    await user.click(screen.getByRole('button', { name: '保存并关闭' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Error: mask offline', 'error'))
    expect(onClose).not.toHaveBeenCalled()
    expect(onStageSaved).toHaveBeenCalledTimes(1)
    expect(onStageSaved.mock.calls[0][0]).toMatchObject({ kind: 'paint', name: '1_data/a.png' })
    expect(screen.getByTestId('dialog-inpaint-canvas')).toHaveTextContent('paint:0 mask:1')

    await user.click(screen.getByRole('button', { name: '保存并关闭' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(api.saveInpaintTrain).toHaveBeenCalledTimes(1)
    expect(api.saveMaskTrain).toHaveBeenCalledTimes(2)
  })

  it('asks before discarding edits on ordinary close', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    mocks.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    render(
      <SingleImageInpaintDialog
        projectId={7}
        versionId={11}
        image={image}
        onClose={onClose}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Draw test stroke' }))
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.stringContaining('未保存的涂抹修改'),
      expect.objectContaining({ title: '有未保存的涂抹修改' }),
    )
    expect(onClose).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})
