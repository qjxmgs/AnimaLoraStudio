import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type ProjectDetail, type Version } from '../../../api/client'
import TagEditPage from './TagEdit'

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  confirm: vi.fn(async () => true),
  reload: vi.fn(async () => undefined),
  setVersionSwitchGuard: vi.fn(),
  onEvent: undefined as undefined | ((event: Record<string, unknown>) => void),
  gridColumns: 2,
  inpaintProps: [] as Array<Record<string, unknown>>,
}))

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return {
    ...actual,
    useBlocker: () => ({ state: 'unblocked' as const }),
  }
})
vi.mock('../../../components/Toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../components/Toast')>()
  return { ...actual, useToast: () => ({ toast: mocks.toast }) }
})
vi.mock('../../../components/Dialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../components/Dialog')>()
  return { ...actual, useDialog: () => ({ confirm: mocks.confirm }) }
})
vi.mock('../../../lib/useEventStream', () => ({
  useEventStream: (callback: (event: Record<string, unknown>) => void) => {
    mocks.onEvent = callback
  },
}))
vi.mock('../../../components/PaneResizer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../components/PaneResizer')>()
  return {
    ...actual,
    default: ({ ariaLabel }: { ariaLabel: string }) => <div role="separator" aria-label={ariaLabel} />,
  }
})
vi.mock('../../../components/ZoomableImage', () => ({
  default: ({ alt, overlay }: { alt: string; overlay?: React.ReactNode }) => (
    <div data-testid="preview-image">{alt}{overlay}</div>
  ),
}))
vi.mock('../../../components/preprocess/TrainingMaskOverlay', () => ({
  default: ({ src }: { src: string }) => (
    <div data-testid="training-mask-overlay" data-src={src} />
  ),
}))
vi.mock('../../../components/preprocess/SingleImageInpaintDialog', () => ({
  default: (props: {
    image: { name: string }
    onDirtyChange?: (dirty: boolean) => void
    onStageSaved?: (stage: Record<string, unknown>) => void
    onClose: () => void
  }) => {
    mocks.inpaintProps.push(props as unknown as Record<string, unknown>)
    return (
      <div role="dialog" aria-label="模拟单图涂抹" data-image={props.image.name}>
        <button type="button" onClick={() => props.onDirtyChange?.(true)}>模拟涂抹修改</button>
        <button
          type="button"
          onClick={() => {
            const nextName = props.image.name.replace(/\.[^.]+$/, '.png')
            props.onStageSaved?.({
              kind: 'paint',
              previousName: props.image.name,
              name: nextName,
              result: {
                name: nextName, origin: props.image.name.slice(props.image.name.lastIndexOf('/') + 1),
                mtime: 99, size: 20, w: 640, h: 480,
              },
            })
          }}
        >
          模拟保存原图
        </button>
        <button type="button" onClick={props.onClose}>关闭模拟涂抹</button>
      </div>
    )
  },
}))
vi.mock('../../../components/ImageGrid', async () => {
  const { useEffect } = await import('react')
  function MockImageGrid({
    items,
    selected,
    onSelect,
    onActivate,
    onColumnCountChange,
    clickMode,
    ariaLabel,
    emptyHint,
  }: {
    items: Array<{ name: string; label?: string; badge?: string }>
    selected: Set<string>
    onSelect: (name: string, event: React.MouseEvent) => void
    onActivate?: (name: string) => void
    onColumnCountChange?: (columns: number) => void
    clickMode?: 'select' | 'activate'
    ariaLabel?: string
    emptyHint?: string
  }) {
    useEffect(() => { onColumnCountChange?.(mocks.gridColumns) }, [onColumnCountChange])
    return (
      <div role="grid" aria-label={ariaLabel}>
        {items.length === 0 ? <span>{emptyHint}</span> : items.map((item) => {
          const label = item.label ?? item.name
          return (
            <div key={item.name}>
              <button
                type="button"
                onClick={(event) => onSelect(item.name, event)}
                aria-pressed={selected.has(item.name)}
              >
                选择 {label}
              </button>
              <button
                type="button"
                onClick={(event) => {
                  if (clickMode === 'select') onSelect(item.name, event)
                  else onActivate?.(item.name)
                }}
              >
                打开 {label}
              </button>
              {item.badge && <span data-testid={`image-badge-${item.name}`}>{item.badge}</span>}
            </div>
          )
        })}
      </div>
    )
  }
  return {
    applySelection: (selected: Set<string>, name: string) => {
      const next = new Set(selected)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return { next, anchor: name }
    },
    default: MockImageGrid,
  }
})
vi.mock('../../../components/TagEditor', () => ({
  default: ({
    tags,
    inactiveTags = new Set<string>(),
    onChange,
    customTags = [],
    customTagsBusy = false,
    onAddCustomTag,
    onDeleteCustomTag,
    onReplaceCustomTags,
  }: {
    tags: string[]
    inactiveTags?: ReadonlySet<string>
    onChange: (tags: string[], inactiveTags: ReadonlySet<string>) => void
    customTags?: string[]
    customTagsBusy?: boolean
    onAddCustomTag?: (tag: string) => void | Promise<void>
    onDeleteCustomTag?: (tag: string) => void | Promise<void>
    onReplaceCustomTags?: (tags: string[]) => void | Promise<void>
  }) => {
    const activeTags = tags.filter((tag) => !inactiveTags.has(tag))
    return (
      <div>
        <span>当前标签 {activeTags.join(',')}</span>
        <input
          aria-label="以文本编辑标签"
          value={activeTags.join(', ')}
          onChange={(event) => {
            const nextActive = event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean)
            onChange(nextActive, new Set())
          }}
        />
        <button
          type="button"
          onClick={() => onChange(
            tags.includes('edited') ? tags : [...tags, 'edited'],
            new Set(Array.from(inactiveTags).filter((tag) => tag !== 'edited')),
          )}
        >
          修改标签
        </button>
        {tags.map((tag) => (
          <button
            key={tag}
            type="button"
            aria-label={`切换标签 ${tag}`}
            aria-pressed={!inactiveTags.has(tag)}
            onClick={() => {
              const nextInactive = new Set(inactiveTags)
              if (nextInactive.has(tag)) nextInactive.delete(tag)
              else nextInactive.add(tag)
              onChange(tags, nextInactive)
            }}
          >
            {tag}
          </button>
        ))}
        <section aria-label="项目常驻标签">
          {customTags.map((tag) => (
            <span key={tag}>
              <button
                type="button"
                disabled={customTagsBusy || activeTags.includes(tag)}
                onClick={() => {
                  const nextInactive = new Set(inactiveTags)
                  nextInactive.delete(tag)
                  onChange(tags.includes(tag) ? tags : [...tags, tag], nextInactive)
                }}
              >
                常驻 {tag}
              </button>
              <button
                type="button"
                disabled={customTagsBusy}
                onClick={() => onDeleteCustomTag?.(tag)}
              >
                删除常驻 {tag}
              </button>
            </span>
          ))}
          <button
            type="button"
            disabled={customTagsBusy}
            onClick={() => onAddCustomTag?.('project_new')}
          >
            添加测试常驻标签
          </button>
          <button
            type="button"
            disabled={customTagsBusy}
            onClick={() => onReplaceCustomTags?.(['replaced', 'quick'])}
          >
            文本更新常驻标签
          </button>
        </section>
      </div>
    )
  },
}))
vi.mock('../../../components/BulkActionBar', () => ({
  default: ({ selectedKeys }: { selectedKeys: string[] }) => (
    <div data-testid="bulk-selection">{selectedKeys.length}</div>
  ),
}))
vi.mock('../../../components/TagStatsPanel', () => ({
  default: ({ selectedKeys, onPickTag }: { selectedKeys: string[]; onPickTag: (tag: string) => void }) => (
    <div>
      <span data-testid="stats-selection">{selectedKeys.join('|')}</span>
      <button type="button" onClick={() => onPickTag('cat')}>选择 cat 图片</button>
    </div>
  ),
}))

const captions = {
  folder: null,
  items: [
    { folder: '人物 A', name: 'a1.png', tags: ['cat'], format: 'json' as const, tag_count: 1, tags_preview: ['cat'], has_caption: true },
    { folder: '人物 A', name: 'a2.png', tags: ['dog'], format: 'txt' as const, tag_count: 1, tags_preview: ['dog'], has_caption: true },
    { folder: '人物 B', name: 'b1.png', tags: ['cat'], format: 'txt' as const, tag_count: 1, tags_preview: ['cat'], has_caption: true },
  ],
}

const cropWorkspace = {
  images: [
    { name: '人物 A/a1.png', source: 'a1.png', w: 640, h: 480, mtime: 1, size: 10, processed: false, mask_mtime: 123 },
    { name: '人物 A/a2.png', source: 'a2.png', w: 640, h: 480, mtime: 1, size: 10, processed: false, mask_mtime: null },
    { name: '人物 B/b1.png', source: 'b1.png', w: 480, h: 640, mtime: 1, size: 10, processed: false, mask_mtime: 456 },
  ],
}

function renderPage(projectOverrides: Partial<ProjectDetail> = {}) {
  const project = {
    id: 7,
    custom_tags: ['cat', 'quick'],
    ...projectOverrides,
  } as ProjectDetail
  const activeVersion = {
    id: 11,
    trigger_word: 'sks',
    stats: { train_image_count: 3, tagged_image_count: 3 },
  } as Version
  return render(
    <MemoryRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      initialEntries={['/tag-edit']}
    >
      <Routes>
        <Route element={<Outlet context={{ project, activeVersion, reload: mocks.reload, setVersionSwitchGuard: mocks.setVersionSwitchGuard }} />}>
          <Route path="/tag-edit" element={<TagEditPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

async function ready() {
  return screen.findByRole('grid', { name: '训练图片标签编辑列表' })
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  localStorage.clear()
  mocks.onEvent = undefined
  mocks.gridColumns = 2
  mocks.inpaintProps.length = 0
  vi.spyOn(api, 'listCaptionsFull').mockResolvedValue(captions)
  vi.spyOn(api, 'listCropWorkspaceTrain').mockResolvedValue(cropWorkspace)
  vi.spyOn(api, 'removeTrainFiles').mockResolvedValue({ removed: [], missing: [] })
  vi.spyOn(api, 'commitCaptions').mockResolvedValue({
    written: 1,
    skipped: [],
    snapshot: { id: 'snap-1', created_at: 1, size: 1, file_count: 1 },
  })
  vi.spyOn(api, 'updateProject').mockImplementation(async (pid, body) => ({
    id: pid,
    custom_tags: body.custom_tags ?? [],
  } as ProjectDetail))
})

describe('TagEdit workspace', () => {
  it('separates first-load failure from an empty dataset and retries', async () => {
    vi.mocked(api.listCaptionsFull)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(captions)
    const user = userEvent.setup()
    renderPage()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Caption 加载失败')
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await ready()).toBeInTheDocument()
  })

  it('renders a genuine empty dataset separately from loading and errors', async () => {
    vi.mocked(api.listCaptionsFull).mockResolvedValue({ folder: null, items: [] })
    renderPage()

    expect(await screen.findByText('还没有可编辑的训练图片')).toBeInTheDocument()
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps the loaded workspace mounted when a background refresh fails', async () => {
    renderPage()
    await ready()
    vi.mocked(api.listCaptionsFull).mockRejectedValueOnce(new Error('offline'))

    act(() => mocks.onEvent?.({
      type: 'version_state_changed',
      project_id: 7,
      version_id: 11,
    }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Caption 刷新失败')
    expect(screen.getByRole('grid', { name: '训练图片标签编辑列表' })).toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getByRole('grid', { name: '训练图片标签编辑列表' })).toBeInTheDocument()
  })

  it('never overwrites dirty captions when a relevant external update arrives', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    await user.click(screen.getByRole('button', { name: '修改标签' }))
    expect(screen.getByRole('button', { name: '保存（1）' })).toBeEnabled()

    act(() => mocks.onEvent?.({
      type: 'job_state_changed',
      kind: 'tag',
      status: 'done',
      project_id: 7,
      version_id: 11,
    }))

    expect(await screen.findByText('检测到外部 caption 更新')).toBeInTheDocument()
    expect(api.listCaptionsFull).toHaveBeenCalledTimes(1)
    expect(screen.getByText('当前标签 cat,edited')).toBeInTheDocument()
  })

  it('does not overwrite an edit made while a background refresh is in flight', async () => {
    const refreshed = {
      ...captions,
      items: captions.items.map((item) => (
        item.folder === '人物 A' && item.name === 'a1.png'
          ? { ...item, tags: ['external'] }
          : item
      )),
    }
    let resolveRefresh!: (value: typeof captions) => void
    const refreshResponse = new Promise<typeof captions>((resolve) => {
      resolveRefresh = resolve
    })
    vi.mocked(api.listCaptionsFull)
      .mockResolvedValueOnce(captions)
      .mockReturnValueOnce(refreshResponse)
    const user = userEvent.setup()
    renderPage()
    await ready()

    act(() => mocks.onEvent?.({
      type: 'version_state_changed',
      project_id: 7,
      version_id: 11,
    }))
    await waitFor(() => expect(api.listCaptionsFull).toHaveBeenCalledTimes(2))
    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    await user.click(screen.getByRole('button', { name: '修改标签' }))
    await act(async () => resolveRefresh(refreshed))

    expect(await screen.findByText('检测到外部 caption 更新')).toBeInTheDocument()
    expect(screen.getByText('当前标签 cat,edited')).toBeInTheDocument()
  })

  it('offers explicit save or discard paths for a dirty external update', async () => {
    const refreshed = {
      ...captions,
      items: captions.items.map((item) => (
        item.folder === '人物 A' && item.name === 'a1.png'
          ? { ...item, tags: ['external'] }
          : item
      )),
    }
    vi.mocked(api.listCaptionsFull)
      .mockResolvedValueOnce(captions)
      .mockResolvedValueOnce(refreshed)
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    await user.click(screen.getByRole('button', { name: '修改标签' }))
    act(() => mocks.onEvent?.({
      type: 'version_state_changed',
      project_id: 7,
      version_id: 11,
    }))

    expect(await screen.findByRole('button', { name: '保存并刷新' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '放弃并刷新' }))

    await waitFor(() => expect(api.listCaptionsFull).toHaveBeenCalledTimes(2))
    expect(api.commitCaptions).not.toHaveBeenCalled()
    expect(screen.queryByText('检测到外部 caption 更新')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    expect(screen.getByText('当前标签 external')).toBeInTheDocument()
  })

  it('saves local edits before merging an external update', async () => {
    vi.mocked(api.listCaptionsFull)
      .mockResolvedValueOnce(captions)
      .mockResolvedValueOnce({
        ...captions,
        items: captions.items.map((item) => (
          item.folder === '人物 A' && item.name === 'a1.png'
            ? { ...item, tags: ['cat', 'edited'] }
            : item
        )),
      })
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    await user.click(screen.getByRole('button', { name: '修改标签' }))
    act(() => mocks.onEvent?.({
      type: 'job_state_changed',
      kind: 'tag',
      status: 'done',
      project_id: 7,
      version_id: 11,
    }))
    await user.click(await screen.findByRole('button', { name: '保存并刷新' }))

    await waitFor(() => expect(api.commitCaptions).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(api.listCaptionsFull).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: '已保存' })).toBeDisabled()
    expect(screen.queryByText('检测到外部 caption 更新')).not.toBeInTheDocument()
  })

  it('preserves edits made to another image while save-and-refresh is in flight', async () => {
    type CommitResponse = Awaited<ReturnType<typeof api.commitCaptions>>
    let resolveCommit!: (value: CommitResponse) => void
    const commitResponse = new Promise<CommitResponse>((resolve) => {
      resolveCommit = resolve
    })
    vi.mocked(api.commitCaptions).mockReturnValueOnce(commitResponse)
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    await user.click(screen.getByRole('button', { name: '修改标签' }))
    act(() => mocks.onEvent?.({
      type: 'version_state_changed',
      project_id: 7,
      version_id: 11,
    }))
    await user.click(await screen.findByRole('button', { name: '保存并刷新' }))
    await waitFor(() => expect(api.commitCaptions).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: '打开 人物 B/b1.png' }))
    await user.click(screen.getByRole('button', { name: '修改标签' }))
    await act(async () => resolveCommit({
      written: 1,
      skipped: [],
      snapshot: { id: 'snap-save', created_at: 3, size: 1, file_count: 1 },
    }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('已保存 1 张，还原点 snap-save', 'success'))
    expect(api.listCaptionsFull).toHaveBeenCalledTimes(1)
    expect(screen.getByText('检测到外部 caption 更新')).toBeInTheDocument()
    expect(screen.getByText('当前标签 cat,edited')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存（1）' })).toBeEnabled()
  })

  it('clears a pending external update after a failed post-save refresh is retried', async () => {
    vi.mocked(api.listCaptionsFull)
      .mockResolvedValueOnce(captions)
      .mockRejectedValueOnce(new Error('refresh offline'))
      .mockResolvedValueOnce(captions)
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    await user.click(screen.getByRole('button', { name: '修改标签' }))
    act(() => mocks.onEvent?.({
      type: 'version_state_changed',
      project_id: 7,
      version_id: 11,
    }))
    await user.click(await screen.findByRole('button', { name: '保存并刷新' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Caption 刷新失败')
    expect(screen.getByText('检测到外部 caption 更新')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试' }))

    await waitFor(() => expect(api.listCaptionsFull).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.queryByText('检测到外部 caption 更新')).not.toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('limits tag picks to the active folder and closes the old editing context on folder change', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a1.png')

    await user.click(screen.getByRole('radio', { name: /人物 B/ }))
    expect(screen.queryByTestId('preview-image')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '选择 cat 图片' }))

    expect(screen.getByTestId('stats-selection')).toHaveTextContent('人物 B/b1.png')
    expect(screen.queryByRole('button', { name: '选择 人物 A/a1.png' })).not.toBeInTheDocument()
  })

  it('selects matching images across folders while the All scope is active', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '选择 cat 图片' }))

    expect(screen.getByTestId('stats-selection')).toHaveTextContent('人物 A/a1.png|人物 B/b1.png')
    expect(screen.getByTestId('bulk-selection')).toHaveTextContent('2')
  })

  it('keeps bulk selection visible instead of opening a single-image editor', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '选择 人物 A/a1.png' }))
    await user.click(screen.getByRole('button', { name: '打开 人物 A/a2.png' }))

    expect(screen.queryByTestId('preview-image')).not.toBeInTheDocument()
    expect(screen.getByTestId('bulk-selection')).toHaveTextContent('2')
    expect(screen.getByRole('button', { name: '选择 人物 A/a2.png' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('navigates within the selection when the open image belongs to it', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    await user.click(screen.getByRole('button', { name: '选择 人物 A/a1.png' }))
    await user.click(screen.getByRole('button', { name: '选择 人物 A/a2.png' }))

    expect(screen.getByText('1/2')).toHaveAttribute('title', '在当前选中的图片中切换')
    await user.click(screen.getByRole('button', { name: '下一张' }))
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a2.png')
  })

  it('navigates the active folder when the open image is outside the selection', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    expect(screen.getByText('1/3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '选择 人物 A/a2.png' }))
    expect(screen.getByText('1/3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '下一张' }))
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a2.png')
  })

  it('navigates horizontally with A/D across rows without wrapping the whole list', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    fireEvent.keyDown(window, { code: 'KeyD', key: 'd' })
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a2.png')
    fireEvent.keyDown(window, { code: 'KeyD', key: 'd' })
    expect(screen.getByTestId('preview-image')).toHaveTextContent('b1.png')
    fireEvent.keyDown(window, { code: 'KeyD', key: 'd' })
    expect(screen.getByTestId('preview-image')).toHaveTextContent('b1.png')

    fireEvent.keyDown(window, { code: 'KeyA', key: 'a' })
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a2.png')
    fireEvent.keyDown(window, { code: 'KeyA', key: 'a' })
    fireEvent.keyDown(window, { code: 'KeyA', key: 'a' })
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a1.png')
  })

  it('uses the visible grid columns for W/S even when the active image is selected', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    await user.click(screen.getByRole('button', { name: '选择 人物 A/a1.png' }))
    await user.click(screen.getByRole('button', { name: '选择 人物 A/a2.png' }))
    fireEvent.keyDown(window, { code: 'KeyS', key: 's' })
    expect(screen.getByTestId('preview-image')).toHaveTextContent('b1.png')
    fireEvent.keyDown(window, { code: 'KeyW', key: 'w' })
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a1.png')

    fireEvent.keyDown(window, { code: 'KeyD', key: 'd' })
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a2.png')
    fireEvent.keyDown(window, { code: 'KeyS', key: 's' })
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a2.png')
  })

  it('keeps WASD inside the current folder filter', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('radio', { name: /人物 A/ }))
    await user.click(screen.getByRole('button', { name: '打开 人物 A/a2.png' }))
    fireEvent.keyDown(window, { code: 'KeyD', key: 'd' })
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a2.png')
  })

  it('ignores WASD while typing, composing, using modifiers, or showing a modal', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))

    const input = screen.getByRole('textbox', { name: '以文本编辑标签' })
    input.focus()
    fireEvent.keyDown(input, { code: 'KeyD', key: 'd' })
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a1.png')

    input.blur()
    fireEvent.keyDown(window, { code: 'KeyD', key: 'd', isComposing: true })
    fireEvent.keyDown(window, { code: 'KeyD', key: 'd', ctrlKey: true })
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a1.png')

    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.appendChild(editable)
    fireEvent.keyDown(editable, { code: 'KeyD', key: 'd' })
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a1.png')
    editable.remove()

    const modal = document.createElement('div')
    modal.setAttribute('aria-modal', 'true')
    document.body.appendChild(modal)
    fireEvent.keyDown(window, { code: 'KeyD', key: 'd' })
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a1.png')
    modal.remove()
  })

  it('does not let a hidden persistent modal shell block WASD', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))

    const hiddenModal = document.createElement('div')
    hiddenModal.setAttribute('aria-modal', 'true')
    hiddenModal.style.visibility = 'hidden'
    document.body.appendChild(hiddenModal)
    fireEvent.keyDown(window, { code: 'KeyD', key: 'd' })
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a2.png')
    hiddenModal.remove()
  })

  it('does not open an editor when WASD is pressed without an active image', async () => {
    renderPage()
    await ready()

    fireEvent.keyDown(window, { code: 'KeyD', key: 'd' })
    expect(screen.queryByTestId('preview-image')).not.toBeInTheDocument()
  })

  it('groups the single-image editor controls in a visible panel header', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))

    expect(screen.getByRole('heading', { level: 2, name: '标签编辑' })).toBeInTheDocument()
    expect(screen.getByText('1 个标签')).toBeInTheDocument()
    const closeButton = screen.getByRole('button', { name: '关闭编辑' })
    expect(closeButton.querySelector('svg')).toHaveAttribute('stroke', 'currentColor')
    await user.click(closeButton)
    expect(screen.queryByTestId('preview-image')).not.toBeInTheDocument()
  })

  it('adds an available project quick tag to the active caption only', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))

    expect(screen.getByRole('button', { name: '常驻 cat' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '常驻 quick' }))

    expect(screen.getByText('当前标签 cat,quick')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存（1）' })).toBeEnabled()
    expect(api.updateProject).not.toHaveBeenCalled()
  })

  it('reactivates a project quick tag as soon as its active chip is pending removal', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))

    await user.click(screen.getByRole('button', { name: '切换标签 cat' }))
    expect(screen.getByRole('button', { name: '常驻 cat' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '常驻 cat' }))

    expect(screen.getByText('当前标签 cat')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '常驻 cat' })).toBeDisabled()
  })

  it('persists project quick-tag changes immediately without dirtying captions', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))

    await user.click(screen.getByRole('button', { name: '添加测试常驻标签' }))
    await waitFor(() => expect(api.updateProject).toHaveBeenCalledWith(7, {
      custom_tags: ['cat', 'quick', 'project_new'],
    }))
    expect(screen.getByRole('button', { name: '已保存' })).toBeDisabled()
    expect(api.commitCaptions).not.toHaveBeenCalled()
    expect(mocks.reload).toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '删除常驻 quick' }))
    await waitFor(() => expect(api.updateProject).toHaveBeenLastCalledWith(7, {
      custom_tags: ['cat', 'project_new'],
    }))

    await user.click(screen.getByRole('button', { name: '文本更新常驻标签' }))
    await waitFor(() => expect(api.updateProject).toHaveBeenLastCalledWith(7, {
      custom_tags: ['replaced', 'quick'],
    }))
    expect(api.commitCaptions).not.toHaveBeenCalled()
  })

  it('keeps project quick tags unchanged and reports an immediate-save failure', async () => {
    vi.mocked(api.updateProject).mockRejectedValueOnce(new Error('offline'))
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))

    await user.click(screen.getByRole('button', { name: '添加测试常驻标签' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(
      '常驻标签保存失败：Error: offline',
      'error',
    ))
    expect(screen.getByRole('button', { name: '常驻 quick' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '常驻 project_new' })).not.toBeInTheDocument()
  })

  it('shows a persisted training-mask toggle that defaults on and survives navigation and remount', async () => {
    const user = userEvent.setup()
    const view = renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    const toggle = screen.getByRole('checkbox', { name: '显示遮罩' })
    expect(toggle).toBeChecked()
    expect(await screen.findByTestId('training-mask-overlay')).toHaveAttribute(
      'data-src',
      `${api.maskUrl(7, 11, '人物 A/a1.png')}&_=123`,
    )

    await user.click(toggle)
    expect(toggle).not.toBeChecked()
    expect(screen.queryByTestId('training-mask-overlay')).not.toBeInTheDocument()
    expect(localStorage.getItem('studio:tagEdit:show_training_mask')).toBe('false')

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a2.png' }))
    expect(screen.getByRole('checkbox', { name: '显示遮罩' })).not.toBeChecked()

    view.unmount()
    renderPage()
    await ready()
    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    expect(screen.getByRole('checkbox', { name: '显示遮罩' })).not.toBeChecked()
  })

  it('opens the single-image inpaint dialog from the preview header before the mask toggle', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))

    const action = screen.getByRole('button', { name: '涂抹' })
    const toggle = screen.getByRole('checkbox', { name: '显示遮罩' })
    expect(action.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await user.click(action)
    expect(screen.getByRole('dialog', { name: '模拟单图涂抹' })).toHaveAttribute(
      'data-image',
      '人物 A/a1.png',
    )
    expect(mocks.inpaintProps).toHaveLength(1)
  })

  it('places the remove button after the mask toggle and leaves the image untouched on cancel', async () => {
    mocks.confirm.mockResolvedValueOnce(false)
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))

    const toggle = screen.getByRole('checkbox', { name: '显示遮罩' })
    const remove = screen.getByRole('button', { name: '从训练集中移除当前图片' })
    expect(toggle.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(remove).toHaveClass('btn-ghost', 'text-err', 'btn-icon')

    await user.click(remove)

    expect(mocks.confirm).toHaveBeenCalledWith(
      '确定要将「人物 A/a1.png」从训练集中移除吗？下载源图和同源的其他图片不会被删除。',
      expect.objectContaining({
        tone: 'danger',
        title: '移除训练图片',
        okText: '移除',
      }),
    )
    expect(api.removeTrainFiles).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '打开 人物 A/a1.png' })).toBeInTheDocument()
  })

  it('removes only the active image, discards its draft, and preserves other drafts', async () => {
    vi.mocked(api.removeTrainFiles).mockResolvedValueOnce({
      removed: ['人物 A/a1.png'],
      missing: [],
    })
    const user = userEvent.setup()
    renderPage()
    await ready()
    expect(screen.getByText('3 张')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a2.png' }))
    await user.click(screen.getByRole('button', { name: '修改标签' }))
    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    await user.click(screen.getByRole('button', { name: '修改标签' }))
    expect(screen.getByRole('button', { name: '保存（2）' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: '从训练集中移除当前图片' }))

    await waitFor(() => expect(api.removeTrainFiles).toHaveBeenCalledWith(7, 11, {
      files: ['人物 A/a1.png'],
    }))
    expect(mocks.confirm).toHaveBeenCalledWith(
      '确定要将「人物 A/a1.png」从训练集中移除吗？当前图片尚未保存的标签修改会被丢弃；下载源图和同源的其他图片不会被删除。',
      expect.objectContaining({ title: '移除训练图片' }),
    )
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '打开 人物 A/a1.png' })).not.toBeInTheDocument()
    })
    expect(screen.getByText('2 张')).toBeInTheDocument()
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a2.png')
    expect(screen.getByRole('button', { name: '保存（1）' })).toBeEnabled()
    expect(mocks.toast).toHaveBeenCalledWith(
      '已从训练集中移除「人物 A/a1.png」',
      'success',
    )

    await user.click(screen.getByRole('button', { name: '保存（1）' }))
    await waitFor(() => expect(api.commitCaptions).toHaveBeenCalledWith(7, 11, [{
      folder: '人物 A',
      name: 'a2.png',
      tags: ['dog', 'edited'],
    }]))
  })

  it('treats an externally missing image as removed and falls back to the previous image', async () => {
    vi.mocked(api.removeTrainFiles).mockResolvedValueOnce({
      removed: [],
      missing: ['人物 B/b1.png'],
    })
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('button', { name: '打开 人物 B/b1.png' }))

    await user.click(screen.getByRole('button', { name: '从训练集中移除当前图片' }))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '打开 人物 B/b1.png' })).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a2.png')
  })

  it('keeps the active image when exact train removal fails', async () => {
    vi.mocked(api.removeTrainFiles).mockRejectedValueOnce(new Error('locked'))
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))

    await user.click(screen.getByRole('button', { name: '从训练集中移除当前图片' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Error: locked', 'error'))
    expect(screen.getByRole('button', { name: '打开 人物 A/a1.png' })).toBeInTheDocument()
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a1.png')
  })

  it('migrates the active image and pending tag draft when inpaint converts a jpg to png', async () => {
    vi.mocked(api.listCaptionsFull).mockResolvedValueOnce({
      folder: null,
      items: [{
        folder: '人物 A', name: 'a1.jpg', tags: ['cat'], format: 'txt' as const,
        tag_count: 1, tags_preview: ['cat'], has_caption: true,
      }],
    })
    const jpgWorkspace = {
      images: [{
        name: '人物 A/a1.jpg', source: 'a1.jpg', w: 640, h: 480,
        mtime: 1, size: 10, processed: false, mask_mtime: 123,
      }],
    }
    vi.mocked(api.listCropWorkspaceTrain).mockResolvedValue(jpgWorkspace)
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.jpg' }))
    await user.click(screen.getByRole('button', { name: '切换标签 cat' }))
    expect(screen.getByRole('button', { name: '切换标签 cat' })).toHaveAttribute('aria-pressed', 'false')

    await user.click(screen.getByRole('button', { name: '涂抹' }))
    vi.mocked(api.listCropWorkspaceTrain).mockResolvedValue({
      images: [{ ...jpgWorkspace.images[0], name: '人物 A/a1.png', mtime: 99, processed: true }],
    })
    await user.click(screen.getByRole('button', { name: '模拟保存原图' }))

    await waitFor(() => expect(screen.getByTestId('preview-image')).toHaveTextContent('a1.png'))
    expect(screen.getByRole('button', { name: '切换标签 cat' })).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: '保存（1）' }))
    await waitFor(() => expect(api.commitCaptions).toHaveBeenCalledWith(7, 11, [{
      folder: '人物 A',
      name: 'a1.png',
      tags: [],
    }]))
  })

  it('removes the old overlay immediately when navigating to an image without a mask', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    expect(await screen.findByTestId('training-mask-overlay')).toHaveAttribute(
      'data-src',
      `${api.maskUrl(7, 11, '人物 A/a1.png')}&_=123`,
    )

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a2.png' }))
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a2.png')
    expect(screen.getByRole('checkbox', { name: '显示遮罩' })).toBeChecked()
    expect(screen.queryByTestId('training-mask-overlay')).not.toBeInTheDocument()
  })

  it('refreshes the active mask cache-buster on project changes without disturbing captions', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    await screen.findByTestId('training-mask-overlay')

    vi.mocked(api.listCropWorkspaceTrain).mockResolvedValueOnce({
      images: cropWorkspace.images.map((image) => (
        image.name === '人物 A/a1.png' ? { ...image, mask_mtime: 999 } : image
      )),
    })
    act(() => mocks.onEvent?.({ type: 'project_state_changed', project_id: 7 }))

    await waitFor(() => expect(screen.getByTestId('training-mask-overlay')).toHaveAttribute(
      'data-src',
      `${api.maskUrl(7, 11, '人物 A/a1.png')}&_=999`,
    ))
    expect(api.listCaptionsFull).toHaveBeenCalledTimes(1)
  })

  it('keeps tag editing usable when mask metadata cannot be loaded', async () => {
    vi.mocked(api.listCropWorkspaceTrain).mockRejectedValueOnce(new Error('offline'))
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    expect(screen.getByTestId('preview-image')).toHaveTextContent('a1.png')
    expect(screen.getByRole('checkbox', { name: '显示遮罩' })).toBeChecked()
    expect(screen.queryByTestId('training-mask-overlay')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps an inactive tag visible until save and excludes it from the commit payload', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    const chip = screen.getByRole('button', { name: '切换标签 cat' })
    await user.click(chip)

    expect(chip).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('0 个标签')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '保存（1）' }))

    await waitFor(() => expect(api.commitCaptions).toHaveBeenCalledWith(7, 11, [{
      folder: '人物 A',
      name: 'a1.png',
      tags: [],
    }]))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '切换标签 cat' })).not.toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: '已保存' })).toBeDisabled()
  })

  it('can restore an inactive tag before save without leaving a dirty draft', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    const chip = screen.getByRole('button', { name: '切换标签 cat' })
    await user.click(chip)
    await user.click(chip)

    expect(chip).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '已保存' })).toBeDisabled()
    expect(api.commitCaptions).not.toHaveBeenCalled()
  })

  it('retains a newly added inactive tag as a saveable draft, then removes it after save', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    await user.click(screen.getByRole('button', { name: '修改标签' }))
    const added = screen.getByRole('button', { name: '切换标签 edited' })
    await user.click(added)

    expect(added).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: '保存（1）' }))
    await waitFor(() => expect(api.commitCaptions).toHaveBeenCalledWith(7, 11, [{
      folder: '人物 A',
      name: 'a1.png',
      tags: ['cat'],
    }]))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '切换标签 edited' })).not.toBeInTheDocument()
    })
  })

  it('preserves each image inactive draft while switching images', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    await user.click(screen.getByRole('button', { name: '切换标签 cat' }))
    await user.click(screen.getByRole('button', { name: '打开 人物 A/a2.png' }))
    expect(screen.getByRole('button', { name: '切换标签 dog' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    expect(screen.getByRole('button', { name: '切换标签 cat' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('keeps an inactive tag visible when its caption write is skipped', async () => {
    vi.mocked(api.commitCaptions).mockResolvedValue({
      written: 0,
      skipped: ['人物 A/a1.png'],
      snapshot: { id: 'snap-inactive', created_at: 2, size: 1, file_count: 0 },
    })
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    await user.click(screen.getByRole('button', { name: '切换标签 cat' }))
    await user.click(screen.getByRole('button', { name: '保存（1）' }))

    await waitFor(() => expect(api.commitCaptions).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: '切换标签 cat' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.getByRole('button', { name: '保存（1）' })).toBeEnabled()
  })

  it('does not clear a newer inactive draft when an older save finishes', async () => {
    type CommitResponse = Awaited<ReturnType<typeof api.commitCaptions>>
    let resolveCommit!: (value: CommitResponse) => void
    vi.mocked(api.commitCaptions).mockReturnValueOnce(new Promise((resolve) => {
      resolveCommit = resolve
    }))
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    await user.click(screen.getByRole('button', { name: '切换标签 cat' }))
    await user.click(screen.getByRole('button', { name: '保存（1）' }))
    await waitFor(() => expect(api.commitCaptions).toHaveBeenCalledWith(7, 11, [{
      folder: '人物 A',
      name: 'a1.png',
      tags: [],
    }]))

    await user.click(screen.getByRole('button', { name: '修改标签' }))
    await act(async () => resolveCommit({
      written: 1,
      skipped: [],
      snapshot: { id: 'snap-stale', created_at: 4, size: 1, file_count: 1 },
    }))

    expect(screen.getByRole('button', { name: '切换标签 cat' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.getByRole('button', { name: '切换标签 edited' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: '保存（1）' })).toBeEnabled()
  })

  it('saves the latest text edit with one dataset-level save action', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    fireEvent.change(screen.getByRole('textbox', { name: '以文本编辑标签' }), {
      target: { value: 'cat, latest' },
    })
    await user.click(screen.getByRole('button', { name: '保存（1）' }))

    await waitFor(() => expect(api.commitCaptions).toHaveBeenCalledWith(7, 11, [{
      folder: '人物 A',
      name: 'a1.png',
      tags: ['cat', 'latest'],
    }]))
  })

  it('marks the dataset and active image as unsaved, then clears both after save', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    await user.click(screen.getByRole('button', { name: '修改标签' }))

    const saveButton = screen.getByRole('button', { name: '保存（1）' })
    expect(saveButton).toHaveClass('btn-danger')
    expect(screen.getByTestId('image-badge-人物 A/a1.png')).toHaveTextContent('未保存')
    const editorHeader = screen.getByRole('heading', { level: 2, name: '标签编辑' }).closest('header')
    expect(editorHeader).not.toBeNull()
    expect(within(editorHeader as HTMLElement).getByText('未保存')).toBeInTheDocument()

    await user.click(saveButton)

    await waitFor(() => expect(screen.getByRole('button', { name: '已保存' })).toBeDisabled())
    expect(screen.queryByTestId('image-badge-人物 A/a1.png')).not.toBeInTheDocument()
    expect(within(editorHeader as HTMLElement).queryByText('未保存')).not.toBeInTheDocument()
  })

  it('registers the existing version-switch guard while edits are dirty', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    await user.click(screen.getByRole('button', { name: '修改标签' }))
    await waitFor(() => {
      const calls = mocks.setVersionSwitchGuard.mock.calls
      expect(calls[calls.length - 1]?.[0]).toEqual(expect.any(Function))
    })

    const calls = mocks.setVersionSwitchGuard.mock.calls
    const guard = calls[calls.length - 1][0] as () => Promise<boolean>
    await expect(guard()).resolves.toBe(true)
    expect(mocks.confirm).toHaveBeenCalledWith(
      '你还有 1 张图的标签未保存。切换页面会丢失这些修改，确定要离开吗？',
      expect.objectContaining({ title: '有未保存的标签修改' }),
    )
  })

  it('keeps skipped caption writes dirty and preserves the commit payload contract', async () => {
    vi.mocked(api.commitCaptions).mockResolvedValue({
      written: 0,
      skipped: ['人物 A/a1.png'],
      snapshot: { id: 'snap-2', created_at: 2, size: 1, file_count: 0 },
    })
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: '打开 人物 A/a1.png' }))
    await user.click(screen.getByRole('button', { name: '修改标签' }))
    await user.click(screen.getByRole('button', { name: '保存（1）' }))

    await waitFor(() => expect(api.commitCaptions).toHaveBeenCalledWith(7, 11, [{
      folder: '人物 A',
      name: 'a1.png',
      tags: ['cat', 'edited'],
    }]))
    expect(screen.getByRole('button', { name: '保存（1）' })).toBeEnabled()
    expect(mocks.toast).toHaveBeenCalledWith('已保存 0 张；1 张未写入，仍保留为待保存', 'error')
  })
})
