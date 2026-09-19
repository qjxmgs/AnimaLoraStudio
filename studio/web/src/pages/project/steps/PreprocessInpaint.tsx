import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useOutletContext } from 'react-router-dom'
import {
  api,
  type CropWorkspaceItem,
  type HeadMaskProposals,
  type ProjectDetail,
  type Version,
} from '../../../api/client'
import ActionGroup from '../../../components/ActionGroup'
import Button from '../../../components/Button'
import Filmstrip from '../../../components/preprocess/Filmstrip'
import { needsMaskReview } from '../../../components/preprocess/autoMaskReview'
import AutoHeadMaskPanel from '../../../components/preprocess/AutoHeadMaskPanel'
import FaceContourMaskPanel, { type AutoHeadMaskState } from '../../../components/preprocess/FaceContourMaskPanel'
import InpaintCanvas, {
  type InpaintCanvasHandle,
  type HeadMaskOverlayRegion,
  type InpaintMode,
  type InpaintStroke,
  type LassoShape,
} from '../../../components/preprocess/InpaintCanvas'
import InpaintToolPanel from '../../../components/preprocess/InpaintToolPanel'
import {
  resolveMaskEdits,
  resolvePaintEdits,
  type InpaintHistoryEntry,
} from '../../../components/preprocess/inpaintHistory'
import {
  hasBlockingVisibleModal,
  INPAINT_TOOL_SHORTCUTS,
  isInpaintTextEntryTarget,
  useInpaintPreferences,
} from '../../../components/preprocess/inpaintPreferences'
import { saveInpaintEdits } from '../../../components/preprocess/saveInpaintEdits'
import PreprocessToolsBar from '../../../components/preprocess/PreprocessToolsBar'
import { SegmentedControl } from '../../../components/SelectionGroup'
import StepShell from '../../../components/StepShell'
import { useToast } from '../../../components/Toast'
import { compareImagePath } from '../../../lib/imageSort'

interface Ctx {
  project: ProjectDetail
  activeVersion: Version | null
  reload: () => Promise<void>
}

type Filter = 'all' | 'pending' | 'edited' | 'undetected'

function splitRel(name: string): { folder: string; filename: string } {
  const i = name.lastIndexOf('/')
  return {
    folder: i >= 0 ? name.slice(0, i) : '',
    filename: i >= 0 ? name.slice(i + 1) : name,
  }
}

/** 状态模型对齐裁剪页：双数据面双桶（strokesByImage / maskStrokesByImage），
 *  随便切图改动都留在内存，保存按当前模式分发（§9 决策 2）。只有活动图挂
 *  真实 canvas，「保存全部」对非活动图走离屏重放。 */
export default function PreprocessInpaintPage() {
  const { project, activeVersion } = useOutletContext<Ctx>()
  return <InpaintWorkspace key={`${project.id}:${activeVersion?.id ?? 0}`} />
}

function InpaintWorkspace() {
  const { t } = useTranslation()
  const { project, activeVersion, reload } = useOutletContext<Ctx>()
  const { toast } = useToast()
  const vid = activeVersion?.id ?? 0
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // ────── Workspace data（复用 crop workspace：name + w/h + mtime + mask_mtime）──────
  const [images, setImages] = useState<CropWorkspaceItem[]>([])
  const [loading, setLoading] = useState(true)

  const refreshWorkspace = useCallback(async () => {
    if (!vid) return
    try {
      const r = await api.listCropWorkspaceTrain(project.id, vid)
      if (!mounted.current) return
      setImages([...r.images].sort((a, b) => compareImagePath(a.name, b.name)))
    } catch {
      /* ignore */
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [project.id, vid])

  useEffect(() => { void refreshWorkspace() }, [refreshWorkspace])

  // ────── Editor state ──────
  // 统一编辑历史：涂抹与 mask 笔画混合入同一时间线 —— 模式只是笔刷，
  // dirty / undo / 保存都跨模式共用，切模式不改变页面状态语义。
  const {
    mode, setMode,
    tool, setTool,
    brush, setBrush,
    recentColors, setRecentColors,
  } = useInpaintPreferences()
  const [activeName, setActiveName] = useState<string | null>(null)
  const [historyByImage, setHistoryByImage] = useState<Record<string, InpaintHistoryEntry[]>>({})
  const [redoByImage, setRedoByImage] = useState<Record<string, InpaintHistoryEntry[]>>({})
  const [filter, setFilter] = useState<Filter>('all')
  const [busy, setBusy] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [autoBusy, setAutoBusy] = useState(false)
  const [faceBusy, setFaceBusy] = useState(false)
  const [quickJobId, setQuickJobId] = useState<number>()
  const [faceReviewMounted, setFaceReviewMounted] = useState(false)
  useEffect(() => { if (mode === 'mask') setFaceReviewMounted(true) }, [mode])
  const [reviewNames, setReviewNames] = useState<string[] | null>(null)
  const [headMaskState, setHeadMaskState] = useState<AutoHeadMaskState | null>(null)
  const [previewState, setPreviewState] = useState<'loading' | 'ready' | 'error'>('ready')

  const canvasRef = useRef<InpaintCanvasHandle | null>(null)

  useEffect(() => {
    if (images.length === 0) return
    if (!activeName || !images.find((im) => im.name === activeName)) {
      setActiveName(images[0].name)
    }
  }, [images, activeName])

  // ────── Derived ──────
  const activeImage = useMemo(
    () => images.find((im) => im.name === activeName) ?? null,
    [images, activeName],
  )
  const activeHistory = useMemo(
    () => (activeName ? (historyByImage[activeName] ?? []) : []),
    [activeName, historyByImage],
  )
  const activeRedo = useMemo(
    () => (activeName ? (redoByImage[activeName] ?? []) : []),
    [activeName, redoByImage],
  )
  const activePaintEdits = useMemo(
    () => resolvePaintEdits(activeHistory),
    [activeHistory],
  )
  const activeMaskEdits = useMemo(
    () => resolveMaskEdits(activeHistory),
    [activeHistory],
  )

  /** dirty 图集合 = 任一数据面有未保存笔画（保存全部 / filter / 计数共用）。 */
  const editedNames = useMemo(
    () => Object.entries(historyByImage)
      .filter(([, h]) => h.length > 0)
      .map(([n]) => n),
    [historyByImage],
  )

  const counts = useMemo(() => {
    const edited = images.filter((im) => (historyByImage[im.name] ?? []).length > 0).length
    const undetected = headMaskState?.images.filter((im) => reviewNames ? reviewNames.includes(im.name) : needsMaskReview(im)).length ?? 0
    return { all: images.length, pending: images.length - edited, edited, undetected }
  }, [images, historyByImage, headMaskState, reviewNames])

  useEffect(() => { setReviewNames(null) }, [headMaskState?.images])

  const filteredImages = useMemo(() => images.filter((im) => {
    const n = (historyByImage[im.name] ?? []).length
    if (filter === 'pending') return n === 0
    if (filter === 'edited') return n > 0
    if (filter === 'undetected') {
      const proposal = headMaskState?.images.find((item) => item.name === im.name)
      return reviewNames ? reviewNames.includes(im.name) : !!proposal && needsMaskReview(proposal)
    }
    return true
  }), [images, filter, historyByImage, headMaskState, reviewNames])

  const activeProposalRegions = useMemo<HeadMaskOverlayRegion[]>(() => {
    if (!activeName || !headMaskState) return []
    const item = headMaskState.images.find((image) => image.name === activeName)
    const selected = new Set(headMaskState.selections[activeName] ?? [])
    return item?.regions.map((region) => ({ ...region, selected: selected.has(region.id) })) ?? []
  }, [activeName, headMaskState])
  const showUndetected = useCallback((names: string[]) => {
    setReviewNames(names)
    setFilter('undetected')
    if (names.length) setActiveName(names[0])
  }, [])
  const refreshAfterAutoMask = useCallback(async () => {
    await refreshWorkspace()
    await reload()
  }, [refreshWorkspace, reload])

  const incorporateAutoMask = useCallback((result: HeadMaskProposals) => {
    setQuickJobId(result.job_id)
    const completed = result.images.filter((item) => (item.status ?? 'done') === 'done')
    const applicable = completed.filter((item) => !item.stale && item.regions.length > 0)
    if (applicable.length > 0) {
      setHistoryByImage((prev) => {
        const next = { ...prev }
        for (const item of applicable) {
          next[item.name] = [
            ...(next[item.name] ?? []),
            {
              kind: 'mask',
              edit: { type: 'auto', regions: item.regions.map((region) => region.mask_region) },
            },
          ]
        }
        return next
      })
      setRedoByImage((prev) => {
        const next = { ...prev }
        for (const item of applicable) next[item.name] = []
        return next
      })
      setMode('mask')
      setTool('brush')
    }
    const heads = applicable.reduce((sum, item) => sum + item.regions.length, 0)
    const failed = result.images.filter((item) => item.status === 'failed').length
    const skipped = result.images.filter((item) => item.status === 'skipped').length
    const stale = result.images.filter((item) => item.stale).length
    const summary = applicable.length > 0
      ? t('preprocessInpaint.headMask.completed', { images: applicable.length, heads })
      : t('preprocessInpaint.headMask.completedNone')
    const issues = [
      failed > 0 ? t('preprocessInpaint.headMask.issueFailed', { n: failed }) : '',
      skipped > 0 ? t('preprocessInpaint.headMask.issueSkipped', { n: skipped }) : '',
      stale > 0 ? t('preprocessInpaint.headMask.issueStale', { n: stale }) : '',
    ].filter(Boolean)
    const message = issues.length > 0
      ? t('preprocessInpaint.headMask.completedWithIssues', {
          summary,
          issues: issues.join(t('preprocessInpaint.headMask.issueSeparator')),
        })
      : summary
    toast(message, applicable.length === 0 && (failed > 0 || skipped > 0) ? 'error'
      : issues.length > 0 ? 'info' : 'success')
  }, [setMode, setTool, t, toast])

  const rawUrl = useCallback((im: CropWorkspaceItem) => {
    const { folder, filename } = splitRel(im.name)
    return api.versionThumbUrl(project.id, vid, 'train', filename, folder, 0)
      + `&_=${im.mtime}`
  }, [project.id, vid])

  const maskBaseUrlFor = useCallback((im: CropWorkspaceItem): string | null => {
    if (im.mask_mtime == null) return null
    return api.maskUrl(project.id, vid, im.name) + `&_=${im.mask_mtime}`
  }, [project.id, vid])

  // ────── Stroke mutations（统一时间线，undo/redo 跨模式）──────
  const pushRecentColor = useCallback((hex: string) => {
    setRecentColors((prev) => [hex, ...prev.filter((c) => c !== hex)].slice(0, 8))
  }, [setRecentColors])

  const pushEntry = useCallback((entry: InpaintHistoryEntry) => {
    if (!activeName) return
    setHistoryByImage((prev) => ({
      ...prev,
      [activeName]: [...(prev[activeName] ?? []), entry],
    }))
    setRedoByImage((prev) => ({ ...prev, [activeName]: [] }))
  }, [activeName])

  const onStrokeEnd = useCallback((s: InpaintStroke) => {
    pushEntry({ kind: 'paint', edit: { type: 'stroke', stroke: s } })
    pushRecentColor(s.color)
  }, [pushEntry, pushRecentColor])

  const onMaskStrokeEnd = useCallback((s: InpaintStroke) => {
    pushEntry({ kind: 'mask', edit: { type: 'stroke', stroke: s } })
  }, [pushEntry])

  const onLassoCreate = useCallback((target: InpaintMode, shape: LassoShape) => {
    pushEntry(target === 'paint'
      ? { kind: 'paint', edit: { type: 'lasso', shape } }
      : { kind: 'mask', edit: { type: 'lasso', shape } })
  }, [pushEntry])

  const onLassoUpdate = useCallback((target: InpaintMode, shape: LassoShape) => {
    pushEntry({ kind: 'lasso-update', target, shape })
  }, [pushEntry])

  const onLassoDelete = useCallback((target: InpaintMode, shapeId: string) => {
    pushEntry({ kind: 'lasso-delete', target, shapeId })
  }, [pushEntry])

  const undo = useCallback(() => {
    if (!activeName) return
    canvasRef.current?.resetStrokeAnchor()
    setHistoryByImage((prev) => {
      const cur = prev[activeName] ?? []
      if (cur.length === 0) return prev
      const last = cur[cur.length - 1]
      setRedoByImage((r) => ({
        ...r,
        [activeName]: [...(r[activeName] ?? []), last],
      }))
      return { ...prev, [activeName]: cur.slice(0, -1) }
    })
  }, [activeName])

  const redo = useCallback(() => {
    if (!activeName) return
    canvasRef.current?.resetStrokeAnchor()
    setRedoByImage((prev) => {
      const cur = prev[activeName] ?? []
      if (cur.length === 0) return prev
      const last = cur[cur.length - 1]
      setHistoryByImage((h) => ({
        ...h,
        [activeName]: [...(h[activeName] ?? []), last],
      }))
      return { ...prev, [activeName]: cur.slice(0, -1) }
    })
  }, [activeName])

  const clearActive = useCallback(() => {
    if (!activeName) return
    canvasRef.current?.resetStrokeAnchor()
    setHistoryByImage((prev) => ({ ...prev, [activeName]: [] }))
    setRedoByImage((prev) => ({ ...prev, [activeName]: [] }))
  }, [activeName])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return
      const el = e.target as HTMLElement | null
      if (
        el &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      ) {
        return
      }
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  useEffect(() => {
    const onToolShortcut = (event: KeyboardEvent) => {
      const nextTool = INPAINT_TOOL_SHORTCUTS[event.code]
      if (
        !nextTool || nextTool === tool || event.defaultPrevented || event.repeat ||
        event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey ||
        isInpaintTextEntryTarget(event.target) || hasBlockingVisibleModal()
      ) return
      event.preventDefault()
      setTool(nextTool)
    }
    window.addEventListener('keydown', onToolShortcut)
    return () => window.removeEventListener('keydown', onToolShortcut)
  }, [setTool, tool])

  const onPickColor = useCallback((hex: string) => {
    setBrush((prev) => ({ ...prev, color: hex }))
    pushRecentColor(hex)
  }, [setBrush, pushRecentColor])

  // ────── Save（保存 = 该图全部未保存改动，两个数据面一次写完）──────
  /** 保存成功后从历史滤掉对应数据面的 entries（redo 时间线随之作废）。 */
  const clearSavedKind = useCallback((name: string, kind: InpaintMode) => {
    setHistoryByImage((prev) => ({
      ...prev,
      [name]: (prev[name] ?? []).filter((h) => (
        h.kind !== kind && !(
          (h.kind === 'lasso-update' || h.kind === 'lasso-delete') &&
          h.target === kind
        )
      )),
    }))
    setRedoByImage((prev) => ({ ...prev, [name]: [] }))
  }, [])

  /** 单图两面保存。活动图可传挂载中的 canvas exporter，离屏图片走共享重放。 */
  const saveImageBoth = useCallback(async (
    im: CropWorkspaceItem,
    paintEdits: ReturnType<typeof resolvePaintEdits>,
    maskEdits: ReturnType<typeof resolveMaskEdits>,
    exporters?: {
      paint: () => Promise<Blob | null>
      mask: () => Promise<{ blob: Blob; coverage: number } | null>
    },
  ): Promise<string> => saveInpaintEdits({
    projectId: project.id,
    versionId: vid,
    image: im,
    imageUrl: rawUrl(im),
    maskBaseUrl: maskBaseUrlFor(im),
    paintEdits,
    maskEdits,
    exporters,
    onStageSaved: (stage) => {
      if (!mounted.current) return
      clearSavedKind(im.name, stage.kind)
    },
  }), [project.id, vid, rawUrl, maskBaseUrlFor, clearSavedKind])

  const saveActive = useCallback(async () => {
    if (!activeName || !activeImage) return
    if (activeHistory.length === 0) return
    setBusy(true)
    try {
      // 活动图用挂载中的 canvas 导出（所见即所得），非活动图才走离屏重放
      const newName = await saveImageBoth(
        activeImage, activePaintEdits, activeMaskEdits,
        {
          paint: () => canvasRef.current?.exportBlob() ?? Promise.resolve(null),
          mask: async () => {
            const r = await canvasRef.current?.exportMaskBlob()
            return r ?? null
          },
        },
      )
      if (!mounted.current) return
      toast(t('preprocessInpaint.toastSaved', { name: newName }), 'success')
      await refreshWorkspace()
      if (!mounted.current) return
      if (newName !== activeName) setActiveName(newName)
      if (mounted.current) void reload()
    } catch (e) {
      if (mounted.current) toast(String(e), 'error')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [
    activeName, activeImage, activeHistory.length,
    activePaintEdits, activeMaskEdits,
    saveImageBoth, refreshWorkspace, reload, toast, t,
  ])

  const saveAll = useCallback(async () => {
    const dirty = editedNames
    if (dirty.length === 0) return
    setBusy(true)
    let ok = 0
    const failed: string[] = []
    try {
      for (const name of dirty) {
        if (!mounted.current) return
        const im = images.find((i) => i.name === name)
        const hist = historyByImage[name] ?? []
        if (!im || hist.length === 0) continue
        try {
          await saveImageBoth(
            im,
            resolvePaintEdits(hist),
            resolveMaskEdits(hist),
          )
          ok++
        } catch {
          failed.push(name)
        }
      }
      if (!mounted.current) return
      toast(
        failed.length > 0
          ? t('preprocessInpaint.toastSavedAllPartial', { ok, failed: failed.length })
          : t('preprocessInpaint.toastSavedAll', { n: ok }),
        failed.length > 0 ? 'error' : 'success',
      )
      await refreshWorkspace()
      if (mounted.current) void reload()
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [
    editedNames, images, historyByImage, saveImageBoth,
    refreshWorkspace, reload, toast, t,
  ])

  // ────── Render ──────
  if (!activeVersion) {
    return (
      <div className="p-6 text-fg-secondary">
        {t('projectStepper.selectVersion')}
      </div>
    )
  }

  return (
    <StepShell
      title={t('steps.preprocess.title')}
      subtitle={t('preprocessInpaint.subtitle')}
      actions={
        <ActionGroup
          aria-label={t('preprocessInpaint.actionsLabel')}
          secondary={(
            <>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || autoBusy || faceBusy || images.length === 0}
              title={busy
                ? t('preprocessInpaint.headMask.unavailableSaving')
                : autoBusy
                  ? t('preprocessInpaint.headMask.unavailableRunning')
                  : images.length === 0
                    ? t('preprocessInpaint.headMask.unavailableEmpty')
                    : undefined}
              loading={autoBusy}
              aria-haspopup="dialog"
              onClick={() => setSetupOpen(true)}
            >
              {autoBusy
                ? t('preprocessInpaint.headMask.runningAction')
                : t('preprocessInpaint.headMask.openSetup')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void saveAll()}
              disabled={busy || autoBusy || faceBusy || editedNames.length === 0}
            >
              {t('preprocessInpaint.saveAll', { n: editedNames.length })}
            </Button>
            </>
          )}
          primary={(
            <Button
              variant="primary"
              size="sm"
              onClick={() => void saveActive()}
              disabled={busy || autoBusy || faceBusy || activeHistory.length === 0}
            >
              {t('preprocessInpaint.saveActive')}
            </Button>
          )}
        />
      }
      belowHeader={<PreprocessToolsBar current="inpaint" projectId={project.id} versionId={vid} />}
    >
      <div className="flex flex-col h-full gap-3 min-h-0">
        <section className="flex flex-col flex-1 min-h-0 rounded-md border border-subtle bg-surface overflow-hidden">
          <header className="flex items-center gap-2 shrink-0 px-2.5 py-1.5 border-b border-subtle text-sm">
            {activeImage && (
              <span
                className="min-w-0 truncate text-fg-tertiary text-xs font-mono"
                title={activeImage.name}
              >
                {activeImage.name} · {activeImage.w}×{activeImage.h}
              </span>
            )}
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              onClick={undo}
              disabled={!activeName || activeHistory.length === 0}
              title="Ctrl+Z"
            >{t('preprocessInpaint.undo')}</Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={redo}
              disabled={!activeName || activeRedo.length === 0}
              title="Ctrl+Shift+Z"
            >{t('preprocessInpaint.redo')}</Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearActive}
              disabled={!activeName || activeHistory.length === 0}
            >{t('preprocessInpaint.clearActive')}</Button>
          </header>

          <div className="flex-1 min-h-0 overflow-hidden p-3">
            {loading && (
              <p className="text-fg-tertiary text-sm">{t('preprocessInpaint.loading')}</p>
            )}
            {!loading && (
              <div
                className="grid gap-3 h-full min-h-0"
                style={{ gridTemplateColumns: '220px minmax(0, 1fr) 260px' }}
              >
                <Filmstrip
                  items={filteredImages}
                  activeName={activeName}
                  onSelect={setActiveName}
                  thumbUrl={(im) => {
                    const { folder, filename } = splitRel(im.name)
                    return api.versionThumbUrl(
                      project.id, vid, 'train', filename, folder, 256,
                    ) + `&_=${im.mtime}`
                  }}
                  ariaLabel={t('preprocessInpaint.filmstripLabel')}
                  header={(
                    <SegmentedControl
                      items={(['all', 'pending', 'edited', ...(headMaskState ? ['undetected' as const] : [])] as const).map((value) => ({
                        value,
                        label: `${t(`preprocessInpaint.filter.${value}`)} ${counts[value]}`,
                      }))}
                      value={filter}
                      onChange={setFilter}
                      ariaLabel={t('preprocessInpaint.filterLabel')}
                      idPrefix="inpaint-image-filter"
                      size="sm"
                      layout="content"
                    />
                  )}
                  itemLabel={(im) => t('preprocessInpaint.imageLabel', { name: im.name })}
                  emptyHint={t(`preprocessInpaint.filmstripEmpty.${filter}`)}
                  renderOverlay={(im) => {
                    const hist = historyByImage[im.name] ?? []
                    const hasPaint = hist.some((h) => h.kind === 'paint')
                    const hasMask = im.mask_mtime != null
                      || hist.some((h) => h.kind === 'mask')
                    if (!hasPaint && !hasMask) return null
                    return (
                      <span className="fs-badge">
                        {hasPaint ? '✎' : ''}{hasMask ? 'M' : ''}
                      </span>
                    )
                  }}
                />

                <div className={`min-w-0 min-h-0 overflow-hidden ${autoBusy || faceBusy || busy ? 'pointer-events-none' : ''}`} aria-busy={autoBusy || faceBusy || busy}>
                  {!activeImage && <p className="text-fg-tertiary text-sm">
                    {t('preprocessInpaint.emptyWorkspace')}{' '}
                    <Link to={`/projects/${project.id}/v/${vid}/preprocess`} className="text-accent hover:underline">{t('preprocessInpaint.goToOverview')}</Link>
                  </p>}
                  {activeImage && <InpaintCanvas
                    key={activeImage.name}
                    ref={canvasRef}
                    imageUrl={rawUrl(activeImage)}
                    imageW={activeImage.w}
                    imageH={activeImage.h}
                    mode={mode}
                    paintEdits={activePaintEdits}
                    maskEdits={activeMaskEdits}
                    maskBaseUrl={maskBaseUrlFor(activeImage)}
                    brush={brush}
                    onBrushAdjust={(next) => setBrush((prev) => ({ ...prev, ...next }))}
                    tool={tool}
                    onStrokeEnd={onStrokeEnd}
                    onMaskStrokeEnd={onMaskStrokeEnd}
                    onLassoCreate={onLassoCreate}
                    onLassoUpdate={onLassoUpdate}
                    onLassoDelete={onLassoDelete}
                    onPickColor={onPickColor}
                    proposalRegions={activeProposalRegions}
                    onProposalPreviewState={setPreviewState}
                  />}
                </div>

                <InpaintToolPanel
                  mode={mode}
                  setMode={setMode}
                  tool={tool}
                  setTool={setTool}
                  brush={brush}
                  setBrush={setBrush}
                  recentColors={recentColors}
                >
                  <AutoHeadMaskPanel
                    projectId={project.id}
                    versionId={vid}
                    activeName={activeName}
                    unsavedCount={editedNames.length}
                    setupOpen={setupOpen}
                    onCloseSetup={() => setSetupOpen(false)}
                    onResults={incorporateAutoMask}
                    onBusyChange={setAutoBusy}
                  />
                  {(mode === 'mask' || faceReviewMounted) && <div hidden={mode !== 'mask'}><FaceContourMaskPanel
                    projectId={project.id}
                    versionId={vid}
                    activeName={activeName}
                    unsavedCount={editedNames.length}
                    previewState={previewState}
                    disabled={busy || autoBusy}
                    ignoreJobId={quickJobId}
                    onBusyChange={setFaceBusy}
                    onStateChange={setHeadMaskState}
                    onShowUndetected={showUndetected}
                    onWorkspaceChanged={refreshAfterAutoMask}
                  /></div>}
                </InpaintToolPanel>
              </div>
            )}
          </div>
        </section>
      </div>
    </StepShell>
  )
}
