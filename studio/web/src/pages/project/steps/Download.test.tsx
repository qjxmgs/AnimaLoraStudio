import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  type DownloadFile,
  type Job,
  type ProjectDetail,
} from '../../../api/client'
import DownloadPage from './Download'

const mocks = vi.hoisted(() => ({
  intersect: undefined as undefined | (() => void),
  toast: vi.fn(),
  confirm: vi.fn(async () => true),
  reload: vi.fn(async () => undefined),
  onEvent: undefined as undefined | ((event: unknown) => void),
}))

vi.mock('../../../components/Toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../components/Toast')>()
  return { ...actual, useToast: () => ({ toast: mocks.toast }) }
})
vi.mock('../../../components/Dialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../components/Dialog')>()
  return { ...actual, useDialog: () => ({ confirm: mocks.confirm }) }
})
vi.mock('../../../lib/useEventStream', () => ({
  useEventStream: (callback: (event: unknown) => void) => { mocks.onEvent = callback },
}))
vi.mock('../../../components/ImageGrid', () => ({
  applySelection: (selected: Set<string>, name: string) => {
    const next = new Set(selected)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    return { next, anchor: name }
  },
  default: ({
    items,
    selected,
    onSelect,
    onActivate,
    onMarqueeSelect,
    ariaLabel,
    className,
    contentClassName,
    emptyHint,
  }: {
    items: { name: string }[]
    selected: Set<string>
    onSelect: (name: string, event: React.MouseEvent) => void
    onMarqueeSelect?: (selected: Set<string>) => void
    onActivate?: (name: string) => void
    ariaLabel?: string
    className?: string
    contentClassName?: string
    emptyHint?: string
  }) => (
    <div role="grid" aria-label={ariaLabel} className={className} data-content-class={contentClassName}>
      {onMarqueeSelect && <button onClick={() => onMarqueeSelect(new Set(items.map((item) => item.name)))}>模拟框选</button>}
      {items.length === 0 ? <span>{emptyHint}</span> : items.map((item) => (
        <div key={item.name}>
          <button type="button" onClick={(event) => onSelect(item.name, event)} aria-pressed={selected.has(item.name)}>
            选择 {item.name}
          </button>
          <button type="button" onClick={() => onActivate?.(item.name)}>
            预览 {item.name}
          </button>
        </div>
      ))}
    </div>
  ),
}))
vi.mock('../../../components/ImagePreviewModal', () => ({
  default: ({ caption, onClose }: { caption?: string; onClose: () => void }) => (
    <div role="dialog" aria-label="图片预览">
      <span>{caption}</span>
      <button type="button" onClick={onClose}>关闭预览</button>
    </div>
  ),
}))
vi.mock('../../../components/PathPicker', () => ({
  default: ({ onPick, onClose }: { onPick: (path: string) => void; onClose: () => void }) => (
    <div role="dialog" aria-label="服务器文件选择器">
      <button type="button" onClick={() => onPick('/srv/images.zip')}>选择测试压缩包</button>
      <button type="button" onClick={onClose}>关闭路径选择器</button>
    </div>
  ),
}))

const files: DownloadFile[] = [
  { name: 'a.png', size: 1024, has_meta: true },
  { name: 'b.jpg', size: 2048, has_meta: false },
]
const runningJob: Job = {
  id: 11,
  project_id: 7,
  version_id: null,
  kind: 'download',
  params: '{}',
  status: 'running',
  started_at: null,
  finished_at: null,
  pid: null,
  log_path: null,
  error_msg: null,
}

function renderPage() {
  const project = { id: 7, download_image_count: 2 } as ProjectDetail
  return render(
    <MemoryRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      initialEntries={['/download']}
    >
      <Routes>
        <Route element={<Outlet context={{ project, activeVersion: null, reload: mocks.reload }} />}>
          <Route path="/download" element={<DownloadPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

async function ready() {
  fireEvent.click(screen.getByRole('tab', { name: /原始素材/ }))
  await screen.findByRole('grid', { name: '已加入项目的原始素材' })
  await screen.findByText('2 张 · 3.0 KB')
}

const preview = {
  tag: 'character_x', api_source: 'danbooru' as const,
  effective_query: 'character_x -rating:explicit', exclude_tags: ['rating:explicit'],
  page: 1, page_size: 30, has_more: true,
  items: ['101', '102', '103'].map(post_id => ({
    source: 'danbooru' as const, post_id, width: 1024, height: 1536, tags: [],
    thumbnail_url: `/thumb/${post_id}`, image_url: `https://cdn.donmai.us/${post_id}.jpg`,
  })),
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { mocks.intersect = () => callback([{ isIntersecting: true }]) }
    observe() {}
    disconnect() {}
  })
  vi.restoreAllMocks()
  vi.clearAllMocks()
  mocks.onEvent = undefined
  vi.spyOn(api, 'listFiles').mockResolvedValue({ items: files, count: files.length })
  vi.spyOn(api, 'getDownloadStatus').mockResolvedValue({ job: null, log_tail: '' })
  vi.spyOn(api, 'previewDownload').mockResolvedValue(preview)
  vi.spyOn(api, 'startDownload').mockResolvedValue(runningJob)
  vi.spyOn(api, 'uploadProjectFiles').mockResolvedValue({ added: ['local.png'], skipped: [] })
  vi.spyOn(api, 'uploadProjectFileFromPath').mockResolvedValue({ added: ['server.png'], skipped: [] })
  vi.spyOn(api, 'deleteProjectFiles').mockResolvedValue({ deleted: ['a.png'], missing: [] })
  vi.spyOn(api, 'cancelJob').mockResolvedValue({ task_id: runningJob.id, canceled: true })
})

describe('Download workspace', () => {
  it('connects marquee selection to the dataset selection and delete count', async () => {
    renderPage()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: '模拟框选' }))
    expect(screen.getByRole('button', { name: '删除 2' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '选择 a.png' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '选择 b.jpg' })).toHaveAttribute('aria-pressed', 'true')
  })

  it.each(['auto', 'manual'])('retracts the floating import notification on %s dismissal', async (mode) => {
    renderPage()
    await ready()
    vi.useFakeTimers()
    try {
      await act(async () => {
        fireEvent.drop(window, { dataTransfer: { types: ['Files'], files: [new File(['x'], 'notice.png')] } })
      })
      const notice = document.querySelector('[data-download-result-notice]')!
      expect(notice.parentElement).toBe(document.body)
      expect(notice).not.toHaveClass('is-closing')
      if (mode === 'manual') {
        fireEvent.click(notice.querySelector('button')!)
      } else {
        act(() => vi.advanceTimersByTime(2999))
        expect(notice).not.toHaveClass('is-closing')
        act(() => vi.advanceTimersByTime(1))
      }
      expect(notice).toHaveClass('is-closing')
      expect(notice).toBeInTheDocument()
      act(() => vi.advanceTimersByTime(220))
      expect(notice).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends only checked Danbooru tag categories and keeps choices when original tags are disabled', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Booru 来源' }), 'danbooru')
    expect(screen.getByRole('checkbox', { name: '画师' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: '普通' })).toBeChecked()
    await user.click(screen.getByRole('checkbox', { name: '角色' }))
    await user.click(screen.getByRole('checkbox', { name: '使用原图标签' }))
    expect(screen.getByRole('checkbox', { name: '普通' })).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: '使用原图标签' }))
    await user.type(screen.getByRole('textbox', { name: '查询标签' }), 'test')
    await user.click(screen.getByRole('button', { name: '查询' }))
    await user.click(screen.getByRole('button', { name: '选择图片 101' }))
    await user.click(screen.getByRole('button', { name: '下载选中 1 张' }))
    expect(api.startDownload).toHaveBeenCalledWith(7, expect.objectContaining({
      api_source: 'danbooru', use_original_tags: true, tag_categories: ['copyright', 'general'],
    }))
  })

  it('imports files dropped on the workspace immediately and ignores unsupported files', async () => {
    renderPage()
    await ready()
    const file = new File(['image'], 'drop.PNG', { type: 'image/png' })
    const dataTransfer = { types: ['Files'], files: [file, new File(['text'], 'note.txt')] }
    const grid = screen.getByRole('grid')
    fireEvent.dragOver(grid, { dataTransfer })
    expect(screen.getByText('松手即可导入到当前数据集')).toBeInTheDocument()
    fireEvent.drop(grid, { dataTransfer })
    await waitFor(() => expect(api.uploadProjectFiles).toHaveBeenCalledWith(7, [file], expect.any(Function)))
    expect(await screen.findByText('导入完成：添加 1 张，跳过 0 张')).toBeInTheDocument()
    expect(screen.queryByText('松手即可导入到当前数据集')).not.toBeInTheDocument()
    expect(mocks.reload).toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalled()
  })

  it('blocks repeat drops during upload and retains failed drops for retry', async () => {
    let rejectUpload: (error: Error) => void = () => {}
    vi.mocked(api.uploadProjectFiles).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectUpload = reject }))
    renderPage()
    await ready()
    const file = new File(['image'], 'retry.png', { type: 'image/png' })
    const dataTransfer = { types: ['Files'], files: [file] }
    fireEvent.drop(window, { dataTransfer })
    fireEvent.drop(window, { dataTransfer })
    expect(api.uploadProjectFiles).toHaveBeenCalledTimes(1)
    await act(async () => rejectUpload(new Error('offline')))
    expect(screen.getByRole('button', { name: '从当前设备导入 1 个文件' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '从当前设备导入 1 个文件' }))
    await waitFor(() => expect(api.uploadProjectFiles).toHaveBeenCalledTimes(2))
  })

  it('clears drag feedback on leaving and does not import internal image drags', async () => {
    renderPage()
    await ready()
    fireEvent.dragOver(window, { dataTransfer: { types: ['Files'] } })
    fireEvent.dragLeave(window, { relatedTarget: null })
    expect(screen.queryByText('松手即可导入到当前数据集')).not.toBeInTheDocument()
    fireEvent.drop(window, { dataTransfer: { types: ['text/uri-list'], files: [] } })
    fireEvent.drop(window, { dataTransfer: { types: ['Files'], files: [new File(['x'], 'bad.txt')] } })
    expect(api.uploadProjectFiles).not.toHaveBeenCalled()
  })

  it('defaults to Danbooru first and downloads exactly the selection with tags off', async () => {
    const user = userEvent.setup()
    renderPage()
    const source = screen.getByRole('combobox', { name: 'Booru 来源' })
    expect(source).toHaveValue('danbooru')
    expect(Array.from(source.querySelectorAll('option')).map(option => option.value)).toEqual(['danbooru', 'gelbooru'])
    expect(screen.getByRole('button', { name: '下载选中 0 张' })).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: '使用原图标签' }))
    await user.type(screen.getByRole('textbox', { name: '查询标签' }), 'character_x')
    await user.click(screen.getByRole('button', { name: '查询' }))
    expect(api.previewDownload).toHaveBeenCalledWith(7, { tag: 'character_x', api_source: 'danbooru', page: 1 })
    expect(screen.getByRole('img', { name: '#101' })).toHaveAttribute('src', '/thumb/101')
    await user.click(screen.getByRole('button', { name: '选择图片 101' }))
    await user.click(screen.getByRole('button', { name: '选择图片 103' }))
    await user.click(screen.getByRole('button', { name: '下载选中 2 张' }))
    expect(api.startDownload).toHaveBeenCalledWith(7, {
      tag: 'character_x', count: 2, post_ids: ['101', '103'], api_source: 'danbooru',
      use_original_tags: false, tag_categories: ['copyright', 'character', 'general'],
    })
  })

  it('preserves selection across pages including returning to page one and clears on source change', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.type(screen.getByRole('textbox', { name: '查询标签' }), 'character_x')
    await user.click(screen.getByRole('button', { name: '查询' }))
    await user.click(screen.getByRole('button', { name: '选择图片 101' }))
    vi.mocked(api.previewDownload).mockResolvedValueOnce({ ...preview, page: 2, has_more: false, items: [{ ...preview.items[0], post_id: '201' }] })
    await act(async () => mocks.intersect?.())
    await user.click(screen.getByRole('button', { name: '全选已加载' }))
    expect(screen.getByRole('button', { name: '下载选中 4 张' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '上一页' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '选择图片 101' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '下载选中 4 张' })).toBeEnabled()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Booru 来源' }), 'gelbooru')
    expect(screen.queryByRole('button', { name: '选择图片 101' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下载选中 0 张' })).toBeDisabled()
    expect(screen.queryByRole('checkbox', { name: '角色' })).not.toBeInTheDocument()
  })

  it('shows query failures, allows retry, and does not download from an empty page', async () => {
    const user = userEvent.setup()
    vi.mocked(api.previewDownload).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ...preview, items: [], has_more: false })
    renderPage()
    await user.type(screen.getByRole('textbox', { name: '查询标签' }), 'none')
    await user.click(screen.getByRole('button', { name: '查询' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('offline')
    await user.click(screen.getByRole('button', { name: '查询' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下载选中 0 张' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '下一页' })).not.toBeInTheDocument()
    expect(api.startDownload).not.toHaveBeenCalled()
  })

  it('pressing Enter always queries and never starts a download', async () => {
    const user = userEvent.setup()
    renderPage()
    const query = screen.getByRole('textbox', { name: '查询标签' })
    await user.type(query, 'character_x{Enter}')
    await user.click(screen.getByRole('button', { name: '选择图片 101' }))
    await user.type(query, '{Enter}')
    expect(api.previewDownload).toHaveBeenCalledTimes(2)
    expect(api.startDownload).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '下载选中 0 张' })).toBeDisabled()
  })

  it('opens a remote preview without selecting or downloading it', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.type(screen.getByRole('textbox', { name: '查询标签' }), 'character_x{Enter}')
    await user.click(screen.getByRole('button', { name: '预览 101' }))
    expect(screen.getByRole('dialog', { name: '图片预览' })).toHaveTextContent('#101')
    expect(api.startDownload).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '下载选中 0 张' })).toBeDisabled()
  })

  it('keeps both acquisition cards visible and imports local files through the shared confirmation', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    const chooseLocalButton = screen.getByRole('button', { name: '选择当前设备文件' })
    expect(chooseLocalButton).toHaveAttribute('title', 'png / jpg / webp / bmp / gif / zip')
    expect(screen.queryByText('png / jpg / webp / bmp / gif / zip')).not.toBeInTheDocument()
    const file = new File(['image'], 'local.png', { type: 'image/png' })
    await user.upload(screen.getByLabelText('当前设备中的图片或 zip 文件'), file)
    const localSummary = document.querySelector('[data-download-import-summary]')
    expect(localSummary).toHaveTextContent('当前设备 · 1 个文件 · 0.0 MB')
    expect(localSummary).toHaveAttribute('title', expect.stringContaining('local.png'))
    expect(screen.getByRole('textbox', { name: '查询标签' })).toHaveValue('')

    vi.mocked(api.uploadProjectFiles).mockResolvedValueOnce({
      added: ['local.png'],
      skipped: [{ name: 'archive-entry.txt', reason: 'unsupported' }],
    })
    await user.click(screen.getByRole('button', { name: '从当前设备导入 1 个文件' }))
    await waitFor(() => expect(api.uploadProjectFiles).toHaveBeenCalledWith(
      7,
      [file],
      expect.any(Function),
    ))
    expect(await screen.findByText('导入完成：添加 1 张，跳过 1 张')).toBeInTheDocument()
    await user.click(screen.getByText('查看 1 个跳过项'))
    expect(screen.getByText(/archive-entry\.txt/)).toBeInTheDocument()
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.reload).toHaveBeenCalled()
  })

  it('keeps selected local files after an upload transport failure', async () => {
    const user = userEvent.setup()
    vi.mocked(api.uploadProjectFiles).mockRejectedValueOnce(new Error('network unavailable'))
    renderPage()
    await ready()

    const file = new File(['image'], 'retry.png', { type: 'image/png' })
    await user.upload(screen.getByLabelText('当前设备中的图片或 zip 文件'), file)
    await user.click(screen.getByRole('button', { name: '从当前设备导入 1 个文件' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Error: network unavailable', 'error'))
    const retrySummary = document.querySelector('[data-download-import-summary]')
    expect(retrySummary).toHaveAttribute('title', expect.stringContaining('retry.png'))
  })

  it('replaces a pending local selection with a server path and waits for shared confirmation', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    const local = new File(['image'], 'replace-me.png', { type: 'image/png' })
    await user.upload(screen.getByLabelText('当前设备中的图片或 zip 文件'), local)
    const pendingSummary = document.querySelector('[data-download-import-summary]')
    expect(pendingSummary).toHaveAttribute('title', expect.stringContaining('replace-me.png'))

    await user.click(screen.getByRole('button', { name: '浏览运行服务器' }))
    expect(screen.getByRole('dialog', { name: '服务器文件选择器' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '选择测试压缩包' }))

    expect(api.uploadProjectFileFromPath).not.toHaveBeenCalled()
    expect(pendingSummary).not.toHaveAttribute('title', expect.stringContaining('replace-me.png'))
    expect(pendingSummary).toHaveTextContent('运行服务器 · /srv/images.zip')
    await user.click(screen.getByRole('button', {
      name: '从运行服务器导入 /srv/images.zip',
    }))
    await waitFor(() => expect(api.uploadProjectFileFromPath).toHaveBeenCalledWith(7, '/srv/images.zip'))
    expect(await screen.findByText('导入完成：添加 1 张，跳过 0 张')).toBeInTheDocument()
  })

  it('replaces a pending server path with files from the current device', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '浏览运行服务器' }))
    await user.click(screen.getByRole('button', { name: '选择测试压缩包' }))
    const serverSummary = document.querySelector('[data-download-import-summary]')
    expect(serverSummary).toHaveTextContent('运行服务器 · /srv/images.zip')

    const local = new File(['image'], 'local-wins.png', { type: 'image/png' })
    await user.upload(screen.getByLabelText('当前设备中的图片或 zip 文件'), local)

    expect(serverSummary).not.toHaveTextContent('/srv/images.zip')
    expect(serverSummary).toHaveTextContent('当前设备 · 1 个文件 · 0.0 MB')
    expect(serverSummary).toHaveAttribute('title', expect.stringContaining('local-wins.png'))
    const importButton = screen.getByRole('button', { name: '从当前设备导入 1 个文件' })
    expect(importButton.closest('[role="status"]')).toBeNull()
    await user.click(importButton)
    await waitFor(() => expect(api.uploadProjectFiles).toHaveBeenCalledWith(
      7,
      [local],
      expect.any(Function),
    ))
    expect(api.uploadProjectFileFromPath).not.toHaveBeenCalled()
  })

  it('deletes selected dataset images immediately without confirmation', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    expect(screen.getByRole('button', { name: '删除 0' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '选择 a.png' }))
    await user.click(screen.getByRole('button', { name: '删除 1' }))
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(api.deleteProjectFiles).toHaveBeenCalledTimes(1)
    expect(api.deleteProjectFiles).toHaveBeenCalledWith(7, ['a.png'])
    await waitFor(() => expect(screen.getByRole('button', { name: '删除 0' })).toBeDisabled())
  })

  it('opens the existing preview flow from an image cell', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '预览 b.jpg' }))
    expect(screen.getByRole('dialog', { name: '图片预览' })).toHaveTextContent('b.jpg')
  })

  it('retains loaded images and offers an in-place retry after refresh failure', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    vi.mocked(api.listFiles).mockRejectedValueOnce(new Error('offline'))

    act(() => mocks.onEvent?.({ type: 'project_state_changed', project_id: 7 }))
    expect(await screen.findByText('图片列表刷新失败')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '预览 a.png' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.queryByText('图片列表刷新失败')).not.toBeInTheDocument())
  })

  it('shows a loading state before the first file inventory resolves', async () => {
    let resolveFiles: ((value: { items: DownloadFile[]; count: number }) => void) | undefined
    vi.mocked(api.listFiles).mockImplementationOnce(() => new Promise((resolve) => {
      resolveFiles = resolve
    }))
    renderPage()

    expect(await screen.findByText('加载中...')).toBeInTheDocument()
    await act(async () => {
      resolveFiles?.({ items: files, count: files.length })
    })
    await ready()
  })

  it('distinguishes an initial load failure from an empty project', async () => {
    vi.mocked(api.listFiles).mockRejectedValueOnce(new Error('offline'))
    const user = userEvent.setup()
    renderPage()

    fireEvent.click(screen.getByRole('tab', { name: /原始素材/ }))
    expect(await screen.findByText('图片列表加载失败')).toBeInTheDocument()
    expect(screen.getByText('图片列表暂时不可用。重试后再检查已有素材。')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试' }))
    await ready()
  })
})
