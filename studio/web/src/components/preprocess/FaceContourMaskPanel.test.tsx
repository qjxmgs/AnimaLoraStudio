import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api, type HeadMaskProposals, type Job, type ModelsCatalog } from '../../api/client'
import FaceContourMaskPanel from './FaceContourMaskPanel'

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  onEvent: undefined as undefined | ((event: Record<string, unknown>) => void),
}))

vi.mock('../Toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../Toast')>()
  return { ...actual, useToast: () => ({ toast: mocks.toast }) }
})
vi.mock('../../lib/useEventStream', () => ({
  useEventStream: (callback: (event: Record<string, unknown>) => void) => {
    mocks.onEvent = callback
  },
}))

const job: Job = {
  id: 41, project_id: 2, version_id: 3, kind: 'preprocess', params: '{}',
  params_decoded: { stage: 'head_mask', mask_targets: ['face_contour'] }, status: 'running', started_at: null,
  finished_at: null, pid: null, log_path: null, error_msg: null,
}

const catalog = {
  head_detector: {
    id: 'head_detector', name: 'Anime Head Detector', description: '',
    repo: 'deepghs/anime_head_detection', revision: '06604f', target_path: 'model.onnx',
    expected_size: 44_585_386, expected_sha256: 'sha', exists: true, valid: true,
    size: 44_585_386, mtime: 1,
  },
  downloads: {},
  face_segmenter: { valid: true },
  background_segmenter: { valid: true },
} as unknown as ModelsCatalog

const proposals: HeadMaskProposals = {
  schema_version: 1,
  job_id: 41,
  model: { revision: '06604f', path: 'model.onnx', input_size: [640, 640], provider: 'CPUExecutionProvider' },
  parameters: { mask_mode: 'face_contour', confidence: 0.413, iou_threshold: 0.7, padding_ratio: 0.1, feather_ratio: 0.03 },
  created_at: 1,
  stale_count: 0,
  undo_available: false,
  images: [
    {
      name: '1_data/A.png', size: [100, 100], source_mtime_ns: 1,
      source_file_size: 2, stale: false, stale_reason: null,
      regions: [
        { id: 'a', score: 0.9, box: [10, 10, 30, 30], mask_region: { x1: 8, y1: 8, x2: 32, y2: 32, feather_x: 1, feather_y: 1 } },
        { id: 'b', score: 0.8, box: [50, 10, 70, 30], mask_region: { x1: 48, y1: 8, x2: 72, y2: 32, feather_x: 1, feather_y: 1 } },
      ],
    },
    {
      name: '1_data/B.png', size: [100, 100], source_mtime_ns: 1,
      source_file_size: 2, stale: false, stale_reason: null, regions: [],
    },
  ],
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof FaceContourMaskPanel>> = {}) {
  return render(<FaceContourMaskPanel
    projectId={2}
    versionId={3}
    activeName="1_data/A.png"
    unsavedCount={0}
    onStateChange={vi.fn()}
    onShowUndetected={vi.fn()}
    onWorkspaceChanged={vi.fn().mockResolvedValue(undefined)}
    {...overrides}
  />)
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.spyOn(api, 'getModelsCatalog').mockResolvedValue(catalog)
  vi.spyOn(api, 'getPreprocessStatusTrain').mockResolvedValue({ job: null, log_tail: '', summary: { image_count: 2 } })
  vi.spyOn(api, 'startHeadMaskDetection').mockResolvedValue(job)
  vi.spyOn(api, 'getHeadMaskProposals').mockResolvedValue(proposals)
  vi.spyOn(api, 'getHeadMaskApplications').mockResolvedValue({ applications: [] })
  vi.spyOn(api, 'applyHeadMaskProposals').mockResolvedValue({ job_id: 41, applied: 1, images: ['1_data/A.png'], undo_available: true })
  vi.spyOn(api, 'undoHeadMaskApply').mockResolvedValue({ job_id: 41, undone: 1, images: ['1_data/A.png'] })
  vi.spyOn(api, 'cancelJob').mockResolvedValue({ task_id: 41, canceled: true })
})

describe('FaceContourMaskPanel', () => {
  it('allows background-only detection without either head model and blocks an empty target list', async () => {
    vi.mocked(api.getModelsCatalog).mockResolvedValue({ ...catalog, head_detector: undefined, face_segmenter: undefined })
    renderPanel()
    const user = userEvent.setup()
    await user.click(screen.getByRole('checkbox', { name: '脸部 · 精细轮廓' }))
    expect(screen.getByRole('button', { name: '检测当前' })).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: '背景 · 二次元人物分割' }))
    expect(screen.queryByRole('button', { name: /下载头部检测/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '检测当前' }))
    expect(api.startHeadMaskDetection).toHaveBeenCalledWith(2, 3, expect.objectContaining({
      mask_targets: ['background'], filenames: ['1_data/A.png'], scope: 'selected',
    }))
  })

  it('reports every missing dependency for combined targets', async () => {
    vi.mocked(api.getModelsCatalog).mockResolvedValue({ ...catalog,
      head_detector: undefined, face_segmenter: undefined, background_segmenter: undefined })
    renderPanel()
    await userEvent.click(screen.getByRole('checkbox', { name: '背景 · 二次元人物分割' }))
    expect(screen.getByRole('button', { name: /下载头部检测/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下载并准备脸部分割模型' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /下载背景分割模型/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '检测全部' })).toBeDisabled()
  })

  it('keeps a successful background selectable when face detection failed', async () => {
    const background = { ...proposals.images[0].regions[0], id: 'bg', target: 'background' as const, coverage: .652, score: undefined }
    vi.mocked(api.getHeadMaskProposals).mockResolvedValue({ ...proposals, schema_version: 3,
      parameters: { ...proposals.parameters, mask_targets: ['face_contour', 'background'] },
      images: [{ ...proposals.images[0], regions: [background], review_status: 'needs_review', target_statuses: {
        face_contour: { status: 'failed', reason: 'detection_failed', count: 0 },
        background: { status: 'done', reason: 'ready', count: 1 },
      } }],
    })
    const state = vi.fn(), filter = vi.fn()
    renderPanel({ onStateChange: state, onShowUndetected: filter })
    const user = userEvent.setup()
    await user.click(screen.getByRole('checkbox', { name: '背景 · 二次元人物分割' }))
    await user.click(screen.getByRole('button', { name: '检测全部' }))
    act(() => mocks.onEvent?.({ type: 'job_state_changed', job_id: 41, status: 'done' }))
    const region = await screen.findByRole('checkbox', { name: '背景 · 遮罩面积 65.2%' })
    expect(region).toBeChecked()
    await user.click((await screen.findAllByRole('button', { name: '未检测 / 需检查（1）' }))[0])
    expect(filter).toHaveBeenCalledWith(['1_data/A.png'])
    await user.click(region)
    expect(screen.getByRole('button', { name: '应用所选（0）' })).toBeDisabled()
    await user.click(region)
    await user.click(screen.getByRole('button', { name: '应用所选（1）' }))
    expect(api.applyHeadMaskProposals).toHaveBeenCalledWith(2, 3, 41, { '1_data/A.png': ['bg'] })
  })

  it('submits all three targets and rejects invalid background parameters', async () => {
    renderPanel()
    const user = userEvent.setup()
    await user.click(screen.getByRole('checkbox', { name: '头部 · 矩形' }))
    await user.click(screen.getByRole('checkbox', { name: '背景 · 二次元人物分割' }))
    await user.click(screen.getByText('检测参数'))
    const threshold = screen.getByRole('spinbutton', { name: '人物阈值' })
    await user.clear(threshold)
    expect(screen.getByRole('button', { name: '检测全部' })).toBeDisabled()
    await user.type(threshold, '0.6')
    await user.click(screen.getByRole('button', { name: '检测全部' }))
    expect(api.startHeadMaskDetection).toHaveBeenCalledWith(2, 3, expect.objectContaining({
      mask_targets: ['face_contour', 'head_box', 'background'], background_threshold: .6,
    }))
  })

  it('ignores events and delayed results owned by a previous workspace', async () => {
    let resolve!: (value: HeadMaskProposals) => void
    vi.mocked(api.getHeadMaskProposals).mockReturnValue(new Promise((done) => { resolve = done }))
    const state = vi.fn()
    const props = { projectId: 2, versionId: 3, activeName: '1_data/A.png', unsavedCount: 0,
      onStateChange: state, onShowUndetected: vi.fn(), onWorkspaceChanged: vi.fn() }
    const { rerender } = render(<FaceContourMaskPanel {...props} />)
    await userEvent.click(await screen.findByRole('button', { name: '检测全部' }))
    act(() => mocks.onEvent?.({ type: 'job_state_changed', job_id: 41, project_id: 99, status: 'done' }))
    expect(api.getHeadMaskProposals).not.toHaveBeenCalled()
    act(() => mocks.onEvent?.({ type: 'job_state_changed', job_id: 41, project_id: 2, status: 'done' }))
    rerender(<FaceContourMaskPanel {...props} projectId={5} versionId={6} />)
    await act(async () => resolve(proposals))
    expect(state).toHaveBeenLastCalledWith(null)
    expect(screen.queryByRole('button', { name: /应用所选/ })).not.toBeInTheDocument()
  })

  it('gates apply and undo while strokes are unsaved', async () => {
    vi.mocked(api.getPreprocessStatusTrain).mockResolvedValue({ job: { ...job, status: 'done' }, log_tail: '', summary: { image_count: 2 } })
    vi.mocked(api.getHeadMaskProposals).mockResolvedValue({ ...proposals, undo_available: true })
    renderPanel({ unsavedCount: 1 })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '应用所选（2）' }))
    await user.click(screen.getByRole('button', { name: '撤销本次自动遮罩' }))
    expect(api.applyHeadMaskProposals).not.toHaveBeenCalled()
    expect(api.undoHeadMaskApply).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('先保存'), 'error')
  })

  it('previews replacement before an explicit confirmation and binds the apply identity', async () => {
    vi.mocked(api.getPreprocessStatusTrain).mockResolvedValue({ job: { ...job, status: 'done' }, log_tail: '', summary: { image_count: 2 } })
    vi.mocked(api.getHeadMaskProposals).mockResolvedValue({ ...proposals, parameters: { ...proposals.parameters, mask_mode: 'face_contour' } })
    vi.mocked(api.getHeadMaskApplications).mockResolvedValue({ applications: [{ job_id: 40, apply_id: 'old-apply',
      images: [{ name: '1_data/A.png', eligible: true, reason: null }] }] })
    vi.spyOn(api, 'previewHeadMaskReplacement').mockResolvedValue({ images: [{ name: '1_data/A.png', restored_pixels: 100,
      ignored_pixels: 0, before_url: 'data:image/png;base64,AA==', after_url: 'data:image/png;base64,AA==' }] })
    const user = userEvent.setup()
    renderPanel()
    await user.click(await screen.findByText('替换旧自动遮罩'))
    await user.selectOptions(await screen.findByLabelText('选择旧应用记录'), '40:old-apply')
    await user.click(screen.getByRole('button', { name: '预览替换差异' }))
    await screen.findByAltText('替换后')
    expect(api.applyHeadMaskProposals).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '确认替换所选图片' }))
    expect(api.applyHeadMaskProposals).toHaveBeenCalledWith(2, 3, 41,
      { '1_data/A.png': ['a', 'b'], '1_data/B.png': [] }, { job_id: 40, apply_id: 'old-apply' })
  })

  it('offers independent model preparation and does not silently use rectangles', async () => {
    vi.mocked(api.getModelsCatalog).mockResolvedValue({ ...catalog, face_segmenter: undefined })
    vi.spyOn(api, 'startModelDownload').mockResolvedValue({ key: 'face_segmenter', status: 'running' })
    const user = userEvent.setup()
    renderPanel()
    expect(await screen.findByRole('checkbox', { name: '脸部 · 精细轮廓' })).toBeChecked()
    expect(screen.getByRole('button', { name: '检测全部' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '下载并准备脸部分割模型' }))
    expect(api.startModelDownload).toHaveBeenCalledWith({ model_id: 'face_segmenter' })
  })

  it('includes partially failed images in the manual-review filter', async () => {
    vi.mocked(api.getPreprocessStatusTrain).mockResolvedValue({ job: { ...job, status: 'done' }, log_tail: '', summary: { image_count: 2 } })
    vi.mocked(api.getHeadMaskProposals).mockResolvedValue({ ...proposals,
      images: [{ ...proposals.images[0], review_status: 'needs_review' }, proposals.images[1]] })
    const filter = vi.fn()
    const user = userEvent.setup()
    renderPanel({ onShowUndetected: filter })
    await user.click((await screen.findAllByRole('button', { name: '未检测 / 需检查（2）' }))[0])
    expect(filter).toHaveBeenCalledWith(['1_data/A.png', '1_data/B.png'])
    expect(screen.getByText(/成功区域仍可审核和应用/)).toBeInTheDocument()
  })

  it('blocks detection while manual strokes are unsaved', async () => {
    const user = userEvent.setup()
    renderPanel({ unsavedCount: 2 })
    await user.click(await screen.findByRole('button', { name: '检测全部' }))
    expect(api.startHeadMaskDetection).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('先保存'), 'error')
  })

  it('blocks application when the actual bitmap preview failed to load', async () => {
    vi.mocked(api.getPreprocessStatusTrain).mockResolvedValue({
      job: { ...job, status: 'done' }, log_tail: '', summary: { image_count: 2 },
    })
    renderPanel({ previewState: 'error' })
    expect(await screen.findByRole('button', { name: '应用所选（2）' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('遮罩预览加载失败')
  })

  it('makes it explicit that selecting contour mode does not convert a legacy proposal', async () => {
    vi.mocked(api.getPreprocessStatusTrain).mockResolvedValue({
      job: { ...job, status: 'done' }, log_tail: '', summary: { image_count: 2 },
    })
    renderPanel()
    await userEvent.click(await screen.findByRole('checkbox', { name: '背景 · 二次元人物分割' }))
    expect(await screen.findByText(/修改设置不会改变旧结果/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '应用所选（2）' })).toBeDisabled()
    expect(api.startHeadMaskDetection).not.toHaveBeenCalled()
  })

  it('submits pinned defaults and loads proposals when the job completes', async () => {
    const user = userEvent.setup()
    const onStateChange = vi.fn()
    renderPanel({ onStateChange })
    await user.click(await screen.findByRole('button', { name: '检测全部' }))
    expect(api.startHeadMaskDetection).toHaveBeenCalledWith(2, 3, {
      scope: 'all', confidence: 0.413, iou_threshold: 0.7,
      model: 'builtin',
      padding_ratio: 0.1, feather_ratio: 0.03,
      mask_targets: ['face_contour'], face_confidence: 0.25, mask_threshold: 0.5, feather_px: 0,
      background_threshold: 0.5, background_protect_px: 0, background_feather_px: 0,
    })
    act(() => {
      mocks.onEvent?.({ type: 'head_mask_progress', job_id: 41, idx: 1, total: 2, status: 'done', detections: 2 })
      mocks.onEvent?.({ type: 'job_state_changed', job_id: 41, status: 'done' })
    })
    expect(await screen.findByText(/2 张图 · 2 个区域 · 已选 2 个/)).toBeInTheDocument()
    await waitFor(() => expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
      selections: { '1_data/A.png': ['a', 'b'], '1_data/B.png': [] },
    })))
  })

  it('lets the user deselect one region, apply the rest, and undo', async () => {
    vi.mocked(api.getPreprocessStatusTrain).mockResolvedValue({
      job: { ...job, status: 'done' }, log_tail: '', summary: { image_count: 2 },
    })
    const user = userEvent.setup()
    const changed = vi.fn().mockResolvedValue(undefined)
    renderPanel({ onWorkspaceChanged: changed })
    const regions = await screen.findAllByRole('checkbox', { name: /脸部 [12] ·/ })
    await user.click(regions[0])
    vi.mocked(api.getHeadMaskProposals).mockResolvedValue({ ...proposals, undo_available: true })
    await user.click(screen.getByRole('button', { name: '应用所选（1）' }))
    expect(api.applyHeadMaskProposals).toHaveBeenCalledWith(2, 3, 41, {
      '1_data/A.png': ['b'], '1_data/B.png': [],
    })
    expect(changed).toHaveBeenCalled()

    await waitFor(() => expect(screen.getByRole('button', { name: '撤销本次自动遮罩' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '撤销本次自动遮罩' }))
    expect(api.undoHeadMaskApply).toHaveBeenCalledWith(2, 3, 41)
  })

  it('offers the fixed model download when it is missing', async () => {
    vi.mocked(api.getModelsCatalog).mockResolvedValue({
      ...catalog,
      head_detector: { ...catalog.head_detector!, exists: false, valid: false, size: 0 },
    })
    vi.spyOn(api, 'startModelDownload').mockResolvedValue({ key: 'head_detector', status: 'running' })
    const user = userEvent.setup()
    renderPanel()
    await user.click(await screen.findByRole('button', { name: /下载头部检测模型/ }))
    expect(api.startModelDownload).toHaveBeenCalledWith({ model_id: 'head_detector' })
  })

  it('cancels a running detection and reports terminal failures', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getPreprocessStatusTrain).mockResolvedValue({
      job, log_tail: '', summary: { image_count: 2 },
    })
    renderPanel()
    await user.click(await screen.findByRole('button', { name: '取消' }))
    expect(api.cancelJob).toHaveBeenCalledWith(41)

    act(() => {
      mocks.onEvent?.({ type: 'job_state_changed', job_id: 41, status: 'failed' })
    })
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('失败'), 'error')
  })

  it('reports a canceled detection without attempting to load partial proposals', async () => {
    vi.mocked(api.getPreprocessStatusTrain).mockResolvedValue({
      job, log_tail: '', summary: { image_count: 2 },
    })
    renderPanel()
    await screen.findByRole('button', { name: '取消' })
    act(() => {
      mocks.onEvent?.({ type: 'job_state_changed', job_id: 41, status: 'canceled' })
    })
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('取消'), 'info')
    expect(api.getHeadMaskProposals).not.toHaveBeenCalled()
  })
})
