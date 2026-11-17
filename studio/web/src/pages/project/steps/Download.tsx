import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './Download.css'
import { useTagSuggest } from '../../../components/tagSuggest/useTagSuggest'
import { TagSuggestList } from '../../../components/tagSuggest/TagSuggestList'
import { TranslatedTag } from '../../../components/tagDisplay/TranslatedTag'
import { tagChipStyle } from '../../../components/tagDisplay/tagChipStyle'
import { useTranslation } from 'react-i18next'
import { useOutletContext } from 'react-router-dom'
import {
  api,
  type DownloadFile,
  type Job,
  type ProjectDetail,
  type UploadResult,
  type Version,
} from '../../../api/client'
import ActionGroup from '../../../components/ActionGroup'
import Alert from '../../../components/Alert'
import Button from '../../../components/Button'
import Card from '../../../components/Card'
import { Input, Select } from '../../../components/FormControl'
import ImageGrid, { applySelection } from '../../../components/ImageGrid'
import ImagePreviewModal from '../../../components/ImagePreviewModal'
import PathPicker from '../../../components/PathPicker'
import StepShell from '../../../components/StepShell'
import UploadProgressBar from '../../../components/UploadProgressBar'
import { useToast } from '../../../components/Toast'
import { compareImageName } from '../../../lib/imageSort'
import { useEventStream } from '../../../lib/useEventStream'
import { formatBytes, useUploadProgress } from '../../../lib/useUploadProgress'

// 跟 studio/datasets.py:IMAGE_EXTS 对齐 — 上传白名单 = 全链路图片白名单 + .zip。
const UPLOAD_ACCEPT =
  '.png,.jpg,.jpeg,.webp,.bmp,.gif,.zip,image/png,image/jpeg,image/webp,image/bmp,image/gif,application/zip'

interface Ctx {
  project: ProjectDetail
  activeVersion: Version | null
  reload: () => Promise<void>
}

type Preview = Awaited<ReturnType<typeof api.previewDownload>>

// 左侧获取与标签设置；右侧区分远程查询结果和已经入库的素材。
export default function DownloadPage() {
  const { t } = useTranslation()
  const { project, reload } = useOutletContext<Ctx>()
  const { toast } = useToast()
  const [job, setJob] = useState<Job | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [files, setFiles] = useState<DownloadFile[]>([])
  const [filesLoading, setFilesLoading] = useState(true)
  const [hasLoadedFiles, setHasLoadedFiles] = useState(false)
  const [filesError, setFilesError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [previewIdx, setPreviewIdx] = useState<number | null>(null)
  const [tagCategories, setTagCategories] = useState<string[]>(['copyright', 'character', 'general'])
  const [useOriginalTags, setUseOriginalTags] = useState(true)
  const [tag, setTag] = useState('')
  const [apiSource, setApiSource] = useState<'gelbooru' | 'danbooru'>(
    'danbooru'
  )
  const [estimate, setEstimate] = useState<Preview | null>(null)
  const [remoteSelected, setRemoteSelected] = useState<Set<string>>(new Set())
  const [remoteAnchor, setRemoteAnchor] = useState<string | null>(null)
  const [remotePreview, setRemotePreview] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<'query' | 'local'>('query')
  const [queryError, setQueryError] = useState<string | null>(null)
  const [hoverInfo, setHoverInfo] = useState<{ item: Preview['items'][number]; rect: DOMRect } | null>(null)
  const hideHover = () => setHoverInfo(null)
  const queryEpoch = useRef(0)
  const remoteScroll = useRef<HTMLDivElement>(null)
  const loadSentinel = useRef<HTMLDivElement>(null)
  const queryPending = useRef(false)
  const [booruAction, setBooruAction] = useState<'estimate' | 'start' | null>(null)
  const [lastUpload, setLastUpload] = useState<UploadResult | null>(null)
  const dismissUpload = useCallback(() => setLastUpload(null), [])
  // 上传任务在 TaskLogDrawer 里独立成 LogSource —— server 端 on_log 推 SSE
  // `project_upload_log` / `project_upload_state`，前端 accumulate 成 lines + status。
  // 不同于 download 走 job 系统（log file 持久化 + 跨刷新可回放），upload 是
  // 同步路由没 job，SSE 期间错过的行就丢了 —— 跨页面 / 刷新拿不到上次的历史
  // 是预期行为（issue #251 "活着的优先" 的精神）。
  const [uploadLogs, setUploadLogs] = useState<string[]>([])
  const [uploadStatus, setUploadStatus] = useState<
    'pending' | 'running' | 'done' | 'failed' | null
  >(null)
  const [uploadStartedAt, setUploadStartedAt] = useState<number | null>(null)
  const [uploadFinishedAt, setUploadFinishedAt] = useState<number | null>(null)

  const refreshFiles = useCallback(async () => {
    setFilesLoading(true)
    setFilesError(null)
    try {
      const r = await api.listFiles(project.id)
      setFiles([...r.items].sort((a, b) => compareImageName(a.name, b.name)))
      setHasLoadedFiles(true)
    } catch {
      setFilesError(t('download.filesLoadError'))
    } finally {
      setFilesLoading(false)
    }
  }, [project.id, t])

  const refreshStatus = useCallback(async () => {
    try {
      const r = await api.getDownloadStatus(project.id)
      setJob(r.job)
      setLogs(r.log_tail ? r.log_tail.split('\n') : [])
    } catch {
      /* ignore */
    }
  }, [project.id])

  useEffect(() => {
    void refreshStatus()
    void refreshFiles()
  }, [refreshStatus, refreshFiles])

  const jobIdRef = useRef<number | null>(null)
  jobIdRef.current = job?.id ?? null
  useEventStream((evt) => {
    const jid = jobIdRef.current
    if (evt.type === 'job_log_appended' && jid && evt.job_id === jid) {
      setLogs((prev) => [...prev, String(evt.text ?? '')])
    } else if (evt.type === 'job_state_changed' && jid && evt.job_id === jid) {
      void refreshStatus()
      if (evt.status === 'done' || evt.status === 'failed') {
        void refreshFiles()
        void reload()
      }
    } else if (
      evt.type === 'project_state_changed' &&
      evt.project_id === project.id
    ) {
      void refreshFiles()
    } else if (
      evt.type === 'project_upload_log' &&
      evt.project_id === project.id
    ) {
      const line = typeof evt.line === 'string' ? evt.line : ''
      if (line) setUploadLogs((prev) => [...prev, line])
    } else if (
      evt.type === 'project_upload_state' &&
      evt.project_id === project.id
    ) {
      const status = evt.status as typeof uploadStatus
      if (status === 'running') {
        setUploadLogs([])  // 新一轮上传，旧 lines 清掉
        setUploadStartedAt(Date.now() / 1000)
        setUploadFinishedAt(null)
      } else if (status === 'done' || status === 'failed') {
        setUploadFinishedAt(Date.now() / 1000)
      }
      setUploadStatus(status)
    }
  }, { onOpen: () => void refreshStatus() })

  useEffect(() => {
    queryEpoch.current += 1
    setEstimate(null)
    setHoverInfo(null)
    setRemoteSelected(new Set())
    setRemoteAnchor(null)
    setRemotePreview(null)
    setQueryError(null)
    setBooruAction(null)
  }, [tag, apiSource, project.id])

  useEffect(() => () => { queryEpoch.current += 1 }, [])

  const doEstimate = async (page = 1, resetSelection = true) => {
    if (!tag.trim() || booruAction !== null || queryPending.current) return
    queryPending.current = true
    const epoch = ++queryEpoch.current
    setBooruAction('estimate')
    setQueryError(null)
    setActiveTab('query')
    try {
      const result = await api.previewDownload(project.id, { tag, api_source: apiSource, page })
      if (epoch !== queryEpoch.current) return
      setEstimate(previous => {
        if (resetSelection || !previous) return result
        const seen = new Set(previous.items.map(item => item.post_id))
        return { ...result, items: [...previous.items, ...result.items.filter(item => !seen.has(item.post_id))] }
      })
      if (resetSelection) {
        setRemoteAnchor(null)
        setRemotePreview(null)
        setRemoteSelected(new Set())
        if (remoteScroll.current) remoteScroll.current.scrollTop = 0
      }
    } catch (e) {
      if (epoch === queryEpoch.current) setQueryError(String(e))
    } finally {
      queryPending.current = false
      if (epoch === queryEpoch.current) setBooruAction(null)
    }
  }

  useEffect(() => {
    const root = remoteScroll.current
    const target = loadSentinel.current
    if (!root || !target || !estimate?.has_more || booruAction || queryError || activeTab !== 'query') return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void doEstimate(estimate.page + 1, false)
    }, { root, rootMargin: '0px 0px 120px 0px' })
    observer.observe(target)
    return () => observer.disconnect()
  // doEstimate reads the current query; a query edit resets estimate above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimate, booruAction, queryError, activeTab])

  const start = async () => {
    if (!estimate || remoteSelected.size === 0 || booruAction !== null || isLive) return
    setBooruAction('start')
    try {
      const j = await api.startDownload(project.id, {
        tag: estimate.tag,
        count: remoteSelected.size,
        post_ids: Array.from(remoteSelected),
        use_original_tags: useOriginalTags,
        ...(apiSource === 'danbooru' ? { tag_categories: tagCategories } : {}),
        api_source: estimate.api_source,
      })
      setJob(j)
      setLogs([])
      toast(t('download.started', { id: j.id }), 'success')
    } catch (e) {
      toast(String(e), 'error')
    } finally {
      setBooruAction(null)
    }
  }

  const cancel = async () => {
    if (!job) return
    try {
      await api.cancelJob(job.id)
      toast(t('download.canceled'), 'success')
    } catch (e) {
      toast(String(e), 'error')
    }
  }

  const isLive = job?.status === 'running' || job?.status === 'pending'
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)

  return (
    <StepShell
      title={t('steps.download.title')}
      subtitle={t('steps.download.subtitle')}
      logSources={[
        job && {
          key: 'download',
          label: t('logDrawer.download'),
          status: job.status,
          lines: logs,
          startedAt: job.started_at,
          finishedAt: job.finished_at,
          onCancel: () => void cancel(),
        },
        uploadStatus && {
          key: 'upload',
          label: t('logDrawer.upload'),
          status: uploadStatus,
          lines: uploadLogs,
          startedAt: uploadStartedAt,
          finishedAt: uploadFinishedAt,
        },
      ]}
    >
    <div className="download-workbench">
      <div
        className="download-sidebar"
        data-download-acquisition-grid
      >
        <Card
          as="section"
          radius="compact"
          className="min-w-0 overflow-hidden"
          aria-labelledby="download-booru-title"
        >
          <header className="border-b border-subtle px-3 py-2">
            <h2 id="download-booru-title" className="m-0 type-panel-title">
              {t('download.modeBooru')}
            </h2>
          </header>
          <div className="p-3">
            <BooruPanel
              tag={tag}
              setTag={setTag}
              apiSource={apiSource}
              setApiSource={setApiSource}
              estimate={estimate}
              action={booruAction}
              isLive={!!isLive}
              onEstimate={() => void doEstimate()}
              tagCategories={tagCategories}
              setTagCategories={setTagCategories}
              useOriginalTags={useOriginalTags}
              setUseOriginalTags={setUseOriginalTags}
            />
          </div>
        </Card>

        <Card
          as="section"
          radius="compact"
          className="min-w-0 overflow-hidden"
          aria-labelledby="download-import-title"
        >
          <header className="border-b border-subtle px-3 py-2">
            <h2 id="download-import-title" className="m-0 type-panel-title">
              {t('download.modeUpload')}
            </h2>
          </header>
          <div className="p-3">
            <UploadPanel
              pid={project.id}
              onUploaded={(result) => {
                setLastUpload(result)
                setActiveTab('local')
                void refreshFiles()
                void reload()
              }}
            />
          </div>
        </Card>
      </div>

      <div className="download-browser">
        <div className="download-tabs" role="tablist" aria-label={t('download.workspaceTabs')}>
          <button type="button" role="tab" aria-selected={activeTab === 'query'} onClick={() => setActiveTab('query')}>
            {t('download.queryResults')}
          </button>
          <button type="button" role="tab" aria-selected={activeTab === 'local'} onClick={() => setActiveTab('local')}>
            {t('download.sectionTitle')} <span>{files.length} · {formatBytes(totalBytes)}</span>
          </button>
        </div>
        {activeTab === 'query' && (
          <section className="download-query-panel" aria-label={t('download.queryResults')} aria-busy={booruAction === 'estimate'}>
            <div className="download-query-toolbar">
              <Button variant="secondary" size="sm" disabled={!estimate?.items.length || booruAction !== null}
                onClick={() => {
                  const next = new Set([...remoteSelected, ...estimate!.items.map(item => item.post_id)])
                  if (next.size > 1000) { toast(t('download.selectionLimit'), 'error'); return }
                  setRemoteSelected(next)
                }}>
                {t('download.selectPage')}
              </Button>
              <Button variant="ghost" size="sm" disabled={!remoteSelected.size || booruAction !== null}
                onClick={() => { setRemoteSelected(new Set()); setRemoteAnchor(null) }}>
                {t('common.deselect')}
              </Button>
              <span className="download-selection-hint">{t('download.selectionHint')}</span>

            </div>
            {queryError && <Alert tone="danger" size="sm" role="alert">{queryError}</Alert>}
            <div className="download-remote-scroll" ref={remoteScroll} onScroll={() => setHoverInfo(null)}>
              {!estimate && <div className="download-query-empty">{booruAction === 'estimate' ? t('download.querying') : t('download.previewHint')}</div>}
              {estimate && !estimate.items.length && <div className="download-query-empty">{t('download.noPreviewResults')}</div>}
              <div className="download-remote-grid">
                {estimate?.items.map((item, index) => (
                  <article key={item.post_id}
                    onMouseEnter={event => { setHoverInfo({ item, rect: event.currentTarget.getBoundingClientRect() }) }}
                    onMouseLeave={hideHover}
                    onFocus={event => { setHoverInfo({ item, rect: event.currentTarget.getBoundingClientRect() }) }}
                    onBlur={hideHover}
                    className={`download-remote-card${remoteSelected.has(item.post_id) ? ' is-selected' : ''}`}>
                    <button type="button" className="download-remote-select" aria-pressed={remoteSelected.has(item.post_id)}
                      aria-label={t('download.selectImage', { id: item.post_id })} disabled={booruAction !== null}
                      onClick={(event) => {
                        const result = applySelection(remoteSelected, item.post_id, event, estimate.items.map(value => value.post_id), remoteAnchor)
                        if (result.next.size > 1000) { toast(t('download.selectionLimit'), 'error'); return }
                        setRemoteSelected(result.next); setRemoteAnchor(result.anchor)
                      }}>
                      <img src={item.thumbnail_url} alt={`#${item.post_id}`} loading="lazy" draggable={false} />
                      <span className="download-check" aria-hidden="true">{remoteSelected.has(item.post_id) && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m5 12 4 4L19 6" />
                        </svg>
                      )}</span>
                      <span className="download-image-caption"><strong>#{item.post_id}</strong><span>{item.width} × {item.height}</span></span>
                    </button>
                    <button className="download-image-preview" type="button" aria-label={`${t('common.preview')} ${item.post_id}`}
                      onClick={() => setRemotePreview(index)}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
                      </svg>
                    </button>
                  </article>
                ))}
              </div>
              <div ref={loadSentinel} className="download-load-sentinel" role="status">
                {booruAction === 'estimate' ? t('download.querying') : estimate && !estimate.has_more ? t('download.allLoaded') : ''}
                {queryError && estimate?.has_more && <Button variant="secondary" size="sm" onClick={() => void doEstimate(estimate.page + 1, false)}>{t('common.retry')}</Button>}
              </div>
            </div>
            <footer className="download-selection-footer">
              <div><strong>{t('download.selectedCount', { n: remoteSelected.size })}</strong><span>{t(useOriginalTags ? 'download.onlySelectedHint' : 'download.imagesOnlyHint')}</span></div>
              <Button variant="primary" onClick={() => void start()} loading={booruAction === 'start'}
                disabled={!estimate || !remoteSelected.size || remoteSelected.size > 1000 || booruAction !== null || !!isLive}>
                {isLive ? t('download.downloading') : t('download.downloadSelected', { n: remoteSelected.size })}
              </Button>
            </footer>
          </section>
        )}
        <div className="download-local-panel" hidden={activeTab !== 'local'}>
      {lastUpload && (
        <UploadResultStrip
          result={lastUpload}
          onDismiss={dismissUpload}
        />
      )}

      {filesError && (
        <Alert
          tone={hasLoadedFiles ? 'warning' : 'danger'}
          size="sm"
          title={t(hasLoadedFiles ? 'download.refreshErrorTitle' : 'download.loadErrorTitle')}
          action={
            <Button variant="secondary" size="sm" onClick={() => void refreshFiles()}>
              {t('common.retry')}
            </Button>
          }
          role="alert"
        >
          {filesError}
        </Alert>
      )}

      <DownloadedGrid
        project={project}
        files={files}
        totalBytes={totalBytes}
        loading={filesLoading}
        emptyHint={
          filesLoading && !hasLoadedFiles
            ? t('common.loading')
            : filesError && !hasLoadedFiles
              ? t('download.loadFailedEmpty')
              : t('download.emptyHint')
        }
        selected={selected}
        anchor={anchor}
        deleting={deleting}
        onSelect={(name, event) => {
          const result = applySelection(
            selected,
            name,
            event,
            files.map((file) => file.name),
            anchor,
          )
          setSelected(result.next)
          setAnchor(result.anchor)
        }}
        onMarqueeSelect={(next) => {
          setSelected(next)
          setAnchor(null)
        }}
        onPreview={(name) => {
          const index = files.findIndex((file) => file.name === name)
          if (index >= 0) setPreviewIdx(index)
        }}
        onSelectAll={() => setSelected(new Set(files.map((file) => file.name)))}
        onClear={() => {
          setSelected(new Set())
          setAnchor(null)
        }}
        onDelete={async () => {
          if (selected.size === 0 || deleting) return
          setDeleting(true)
          try {
            const result = await api.deleteProjectFiles(project.id, Array.from(selected))
            toast(
              t('download.deletedToast', { deleted: result.deleted.length }) +
                (result.missing.length
                  ? t('download.deletedSkipped', { skipped: result.missing.length })
                  : ''),
              'success',
            )
            setSelected(new Set())
            setAnchor(null)
            await refreshFiles()
            void reload()
          } catch (error) {
            toast(String(error), 'error')
          } finally {
            setDeleting(false)
          }
        }}
      />
        </div>
      </div>
    </div>

    {hoverInfo && <DownloadTagPopover item={hoverInfo.item} rect={hoverInfo.rect}
      onClose={() => setHoverInfo(null)} />}
    {remotePreview !== null && estimate?.items[remotePreview] && (
      <ImagePreviewModal
        src={"/api/gallery/image?" + new URLSearchParams({ source: estimate.api_source, post_id: estimate.items[remotePreview].post_id, url: estimate.items[remotePreview].image_url })}
        caption={`#${estimate.items[remotePreview].post_id}`}
        index={remotePreview} total={estimate.items.length}
        hasPrev={remotePreview > 0} hasNext={remotePreview < estimate.items.length - 1}
        onClose={() => setRemotePreview(null)}
        onPrev={() => setRemotePreview(Math.max(0, remotePreview - 1))}
        onNext={() => setRemotePreview(Math.min(estimate.items.length - 1, remotePreview + 1))}
      />
    )}
    {previewIdx !== null && files[previewIdx] && (
      <ImagePreviewModal
        src={api.projectThumbUrl(project.id, files[previewIdx].name, 'download', 1600)}
        caption={files[previewIdx].name}
        index={previewIdx}
        total={files.length}
        hasPrev={previewIdx > 0}
        hasNext={previewIdx < files.length - 1}
        onClose={() => setPreviewIdx(null)}
        onPrev={() => previewIdx > 0 && setPreviewIdx(previewIdx - 1)}
        onNext={() => previewIdx < files.length - 1 && setPreviewIdx(previewIdx + 1)}
      />
    )}
    </StepShell>
  )
}

// ---------------------------------------------------------------------------
// 已下载 grid — 多选 + 删除
// ---------------------------------------------------------------------------

function DownloadedGrid({
  project,
  files,
  totalBytes,
  loading,
  emptyHint,
  selected,
  anchor,
  deleting,
  onSelect,
  onMarqueeSelect,
  onPreview,
  onSelectAll,
  onClear,
  onDelete,
}: {
  project: ProjectDetail
  files: DownloadFile[]
  totalBytes: number
  loading: boolean
  emptyHint: string
  selected: Set<string>
  anchor: string | null
  deleting: boolean
  onSelect: (name: string, e: React.MouseEvent) => void
  onMarqueeSelect: (selected: Set<string>) => void
  onPreview: (name: string) => void
  onSelectAll: () => void
  onClear: () => void
  onDelete: () => void | Promise<void>
}) {
  const { t } = useTranslation()
  // anchor 仅父组件用，这里不读但保留参数避免未来漂移
  void anchor
  const items = useMemo(
    () =>
      files.map((f) => ({
        name: f.name,
        thumbUrl: api.projectThumbUrl(project.id, f.name),
      })),
    [files, project.id]
  )
  return (
    <Card
      as="section"
      radius="compact"
      className="flex flex-col flex-1 min-h-0 overflow-hidden"
      aria-busy={loading || undefined}
    >
      <header className="flex flex-wrap items-center gap-related shrink-0 px-3 py-2 border-b border-subtle text-sm">
        <h2 className="font-semibold">{t('download.sectionTitle')}</h2>
        <span className="text-fg-tertiary">
          {t('download.workspaceSummary', { n: files.length, size: formatBytes(totalBytes) })}
        </span>
        <ActionGroup
          className="ml-auto"
          aria-label={t('download.gridActionsLabel')}
          status={selected.size > 0 && (
            <span className="text-accent text-xs">
              {t('download.selectedCount', { n: selected.size })}
            </span>
          )}
          secondary={(
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={onSelectAll}
                disabled={files.length === 0 || deleting}
              >
                {t('common.selectAll')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onClear}
                disabled={selected.size === 0 || deleting}
              >
                {t('common.deselect')}
              </Button>
            </>
          )}
          primary={(
            <Button
              variant="danger"
              size="sm"
              onClick={() => void onDelete()}
              disabled={selected.size === 0 || deleting}
              loading={deleting}
              title={t('download.deleteTitle')}
            >
              {deleting ? t('download.deleting') : t('download.deleteBtn', { n: selected.size })}
            </Button>
          )}
        />
      </header>
      <ImageGrid
        className="flex-1 min-h-0"
        contentClassName="p-2"
        items={items}
        selected={selected}
        onSelect={onSelect}
        onMarqueeSelect={deleting ? undefined : onMarqueeSelect}
        onActivate={onPreview}
        onPreview={onPreview}
        clickMode="activate"
        ariaLabel={t('download.gridLabel')}
        emptyHint={emptyHint}
      />
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Booru 紧凑 panel
// ---------------------------------------------------------------------------

interface BooruPanelProps {
  tag: string
  setTag: (v: string) => void
  apiSource: 'gelbooru' | 'danbooru'
  setApiSource: (v: 'gelbooru' | 'danbooru') => void
  estimate: Preview | null
  action: 'estimate' | 'start' | null
  isLive: boolean
  onEstimate: () => void
  tagCategories: string[]
  setTagCategories: (value: string[]) => void
  useOriginalTags: boolean
  setUseOriginalTags: (value: boolean) => void
}

function BooruPanel({ tag, setTag, apiSource, setApiSource, estimate, action, isLive,
  onEstimate, useOriginalTags, setUseOriginalTags, tagCategories, setTagCategories }: BooruPanelProps) {
  const { t } = useTranslation()
  const disabled = action !== null || isLive
  const queryInput = useRef<HTMLInputElement>(null)
  const suggest = useTagSuggest({
    value: tag, inputRef: queryInput, tokenMode: 'whitespace', disabled,
    onPick: ({ suggestion, range }) => {
      const before = tag.slice(0, range.start)
      const modifier = tag.slice(range.start, range.end).match(/^[-~]/)?.[0] ?? ''
      const picked = modifier + suggestion.tag.replace(/\s+/g, '_')
      const after = tag.slice(range.end).replace(/^\s+/, '')
      setTag(`${before}${picked} ${after}`)
      requestAnimationFrame(() => {
        queryInput.current?.focus()
        queryInput.current?.setSelectionRange(before.length + picked.length + 1, before.length + picked.length + 1)
      })
    },
  })
  return (
    <form className="download-query-form" aria-label={t('download.booruFormLabel')}
      onSubmit={(event) => { event.preventDefault(); if (tag.trim() && !disabled) onEstimate() }}>
      <label htmlFor="download-source">{t('download.sourceLabel')}</label>
      <Select id="download-source" value={apiSource} disabled={disabled}
        onChange={(event) => setApiSource(event.target.value as 'danbooru' | 'gelbooru')}>
        <option value="danbooru">Danbooru</option>
        <option value="gelbooru">Gelbooru</option>
      </Select>
      <label htmlFor="download-query">{t('download.tagLabel')}</label>
      <Input id="download-query" ref={queryInput} value={tag} disabled={disabled}
        autoComplete="off" aria-autocomplete="list" aria-controls={suggest.open ? 'download-query-suggestions' : undefined}
        onChange={(event) => { setTag(event.target.value); suggest.notifyChange() }}
        onKeyDown={(event) => { if (!event.nativeEvent.isComposing) suggest.handleKeyDown(event) }}
        onClick={suggest.notifyClick} onBlur={suggest.notifyBlur}
        placeholder={t('download.tagPlaceholder')} />
      <TagSuggestList compactStacked id="download-query-suggestions" inputRef={queryInput}
        open={suggest.open} pending={suggest.pending} suggestions={suggest.suggestions}
        activeIdx={suggest.activeIdx} onHover={suggest.setActiveIdx}
        onPick={item => suggest.pickAt(suggest.suggestions.indexOf(item))} />
      <Button type="submit" variant="primary" loading={action === 'estimate'} disabled={disabled || !tag.trim()}>
        {action === 'estimate' ? t('download.querying') : t('download.query')}
      </Button>
      <p className="download-query-summary" role="status">
        {estimate ? t('download.pageLoaded', { n: estimate.items.length }) : t('download.notQueried')}
        {!!estimate?.exclude_tags.length && <span title={estimate.effective_query}> · {t('download.exclusionsApplied', { n: estimate.exclude_tags.length })}</span>}
      </p>
      <div className="download-tag-settings">
        <label className="download-toggle-row">
          <span>{t('download.useOriginalTags')}</span>
          <input className="download-switch" type="checkbox" checked={useOriginalTags} disabled={disabled}
            onChange={(event) => setUseOriginalTags(event.target.checked)} />
        </label>
        <p>{t(useOriginalTags ? 'download.useOriginalTagsHint' : 'download.noTagsHint')}</p>
        {apiSource === 'danbooru' && <div className="download-tag-chips">
          {(['artist', 'copyright', 'character', 'general', 'meta'] as const).map(category => (
            <label key={category} className="download-tag-chip">
              <input type="checkbox" checked={tagCategories.includes(category)} disabled={disabled || !useOriginalTags}
                onChange={event => setTagCategories(event.target.checked ? [...tagCategories, category] : tagCategories.filter(value => value !== category))} />
              <span>{t(`download.tagCategory.${category}`)}</span>
            </label>
          ))}
        </div>}
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// 文件导入：两个来源，共用选择摘要与确认动作
// ---------------------------------------------------------------------------

function UploadPanel({
  pid,
  onUploaded,
}: {
  pid: number
  onUploaded: (r: UploadResult) => void
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const [picked, setPicked] = useState<File[]>([])
  const [serverPath, setServerPath] = useState('')
  const [uploading, setUploading] = useState(false)
  const uploadingRef = useRef(false)
  const resetTimer = useRef<number | undefined>(undefined)
  const [dragging, setDragging] = useState(false)
  const [showPathPicker, setShowPathPicker] = useState(false)
  const uploadProgress = useUploadProgress()

  const resetLocalInput = () => {
    setPicked([])
    if (inputRef.current) inputRef.current.value = ''
  }
  const chooseLocal = (files: FileList | null) => {
    if (!files || files.length === 0) return
    setServerPath('')
    setPicked(Array.from(files))
  }
  const chooseServer = (path: string) => {
    resetLocalInput()
    setServerPath(path)
    setShowPathPicker(false)
  }
  const clearSelection = () => {
    resetLocalInput()
    setServerPath('')
  }
  const applyUploadResult = (result: UploadResult) => {
    onUploaded(result)
  }
  const submit = async (localFiles = picked, path = serverPath) => {
    if (uploadingRef.current || (localFiles.length === 0 && !path)) return
    uploadingRef.current = true
    window.clearTimeout(resetTimer.current)
    const isLocal = localFiles.length > 0
    setUploading(true)
    if (isLocal) {
      uploadProgress.start(localFiles.reduce((sum, file) => sum + file.size, 0))
    }
    try {
      const result = isLocal
        ? await api.uploadProjectFiles(pid, localFiles, uploadProgress.onProgress)
        : await api.uploadProjectFileFromPath(pid, path)
      if (isLocal) uploadProgress.finish()
      applyUploadResult(result)
      clearSelection()
      if (isLocal) {
        resetTimer.current = window.setTimeout(() => uploadProgress.reset(), 800)
      }
    } catch (error) {
      if (isLocal) uploadProgress.fail(error)
      toast(String(error), 'error')
    } finally {
      uploadingRef.current = false
      setUploading(false)
    }
  }
  // Listen on the window while this dataset page is mounted, including its header
  // and empty workspace. Only external file drags override browser behavior.
  useEffect(() => {
    const isFileDrag = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const over = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = uploadingRef.current ? 'none' : 'copy'
      setDragging(!uploadingRef.current)
    }
    const leave = (event: DragEvent) => {
      if (!event.relatedTarget) setDragging(false)
    }
    const clear = () => setDragging(false)
    const drop = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      clear()
      if (uploadingRef.current) return
      const incoming = Array.from(event.dataTransfer?.files ?? [])
      const supported = incoming.filter((file) => /\.(png|jpe?g|webp|bmp|gif|zip)$/i.test(file.name))
      if (supported.length !== incoming.length || !supported.length) {
        toast(t('download.dropUnsupported'), 'error')
      }
      if (!supported.length) return
      setShowPathPicker(false)
      setServerPath('')
      setPicked(supported)
      void submit(supported, '')
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    window.addEventListener('dragend', clear)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      window.removeEventListener('dragend', clear)
      window.removeEventListener('blur', clear)
    }
  })
  useEffect(() => () => window.clearTimeout(resetTimer.current), [])
  const totalBytes = picked.reduce((sum, file) => sum + file.size, 0)
  const fileNames = picked.map((file) => file.name).join(', ')
  const source = picked.length > 0 ? 'local' : serverPath ? 'server' : null
  const selectionSummary = source === 'local'
    ? `${t('download.currentDeviceSource')} · ${t('download.filesSelected', {
      n: picked.length,
      mb: (totalBytes / 1024 / 1024).toFixed(1),
    })}`
    : source === 'server'
      ? `${t('download.serverSource')} · ${serverPath}`
      : t('download.noImportSelection')
  const selectionTitle = source === 'local' && fileNames
    ? `${selectionSummary} · ${fileNames}`
    : selectionSummary
  const importLabel = source === 'local'
    ? t('download.importDeviceAria', { n: picked.length })
    : source === 'server'
      ? t('download.importServerAria', { path: serverPath })
      : t('download.importButton')

  return (
    <div className="flex flex-col gap-2">
      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent-soft/90" role="status">
          <span className="rounded-lg bg-surface px-6 py-4 text-lg font-semibold text-accent">
            {t('download.dropToImport')}
          </span>
        </div>
      )}
      <p className="m-0 text-xs text-fg-tertiary">{t('download.dropHint')}</p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        onChange={(event) => chooseLocal(event.target.files)}
        disabled={uploading}
        className="hidden"
        aria-label={t('download.localFilesLabel')}
      />

      <div className="download-import-buttons">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          title={t('download.acceptedFormats')}
          className={dragging ? 'border-accent bg-accent-soft' : ''}
        >
          {t('download.chooseFiles')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setShowPathPicker(true)}
          disabled={uploading}
        >
          {t('download.uploadFromPath')}
        </Button>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-related border-t border-subtle pt-2">
        <p
          className="m-0 min-w-0 flex-1 truncate text-sm font-medium text-fg-primary"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          title={source ? selectionTitle : undefined}
          data-download-import-summary
        >
          {selectionSummary}
        </p>
        <ActionGroup
          aria-label={t('download.importActionsLabel')}
          secondary={source && (
            <Button variant="ghost" size="sm" onClick={clearSelection} disabled={uploading}>
              {t('common.cancel')}
            </Button>
          )}
          primary={(
            <Button
              variant="primary"
              size="sm"
              onClick={() => void submit()}
              loading={uploading}
              disabled={!source}
              aria-label={importLabel}
              title={source ? importLabel : undefined}
            >
              {uploading ? t('download.importing') : t('download.importButton')}
            </Button>
          )}
        />
      </div>

      {uploadProgress.state.phase !== 'idle' && (
        <UploadProgressBar state={uploadProgress.state} />
      )}
      {showPathPicker && (
        <PathPicker
          dirOnly={false}
          onClose={() => setShowPathPicker(false)}
          onPick={chooseServer}
        />
      )}
    </div>
  )
}

function UploadResultStrip({
  result,
  onDismiss,
}: {
  result: UploadResult
  onDismiss: () => void
}) {
  const { t } = useTranslation()
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    setClosing(false)
    const timer = window.setTimeout(() => setClosing(true), 3000)
    return () => window.clearTimeout(timer)
  }, [result])
  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(onDismiss, 220)
    return () => window.clearTimeout(timer)
  }, [closing, onDismiss])
  const skipped = result.skipped.length
  const added = result.added.length
  return createPortal(
    <div className={`download-result-notice${closing ? " is-closing" : ""}`} data-download-result-notice>
    <Alert
      tone={skipped > 0 ? 'warning' : 'success'}
      size="sm"
      title={(
        <span role="status" aria-live="polite" aria-atomic="true">
          {t('download.uploadResultTitle', { added, skipped })}
        </span>
      )}
      action={(
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          onClick={() => setClosing(true)}
          aria-label={t('common.close')}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </Button>
      )}
    >
      {skipped > 0 ? (
        <details>
          <summary className="cursor-pointer text-sm">
            {t('download.reviewSkipped', { n: skipped })}
          </summary>
          <ul className="mt-2 max-h-40 overflow-y-auto p-0 font-mono text-xs list-none">
            {result.skipped.map((item, index) => (
              <li key={`${item.name}-${index}`} className="truncate">
                {item.name} <span className="text-fg-tertiary">— {item.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Alert>
    </div>,
    document.body,
  )
}


function DownloadTagPopover({ item, rect, onClose }: {
  item: Preview['items'][number]; rect: DOMRect; onClose: () => void
}) {
  const { t } = useTranslation()
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false })
  useEffect(() => {
    const update = () => {
      const width = panel.current?.offsetWidth ?? 500
      const height = panel.current?.offsetHeight ?? 400
      const right = rect.right + 10
      const left = right + width <= window.innerWidth - 10 ? right : rect.left - width - 10
      setPosition({ left: Math.max(10, Math.min(left, window.innerWidth - width - 10)),
        top: Math.max(10, Math.min(rect.top, window.innerHeight - height - 10)), ready: true })
    }
    const observer = new ResizeObserver(update)
    if (panel.current) observer.observe(panel.current)
    update()
    window.addEventListener('resize', onClose)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', escape)
    return () => { observer.disconnect(); window.removeEventListener('resize', onClose); window.removeEventListener('keydown', escape) }
  }, [rect, onClose])
  const groups = item.tag_groups ?? { general: item.tags }
  return createPortal(<div ref={panel} className="download-tag-popover" role="tooltip"
    style={{ left: position.left, top: position.top, visibility: position.ready ? 'visible' : 'hidden' }}
    >
    <strong>{t('download.imageDetails')}</strong>
    {item.created_at && <p>{t('download.uploadedAt')} {item.created_at}</p>}
    <p>{t('download.imageResolution')} {item.width} × {item.height}</p>
    {Object.entries(groups).map(([category, tags]) => tags.length > 0 && <section key={category}>
      <h3>{t(`download.tagCategory.${category}`)}</h3>
      <div className="download-hover-tags">{tags.map((tag, index) => <span key={`${tag}-${index}`} style={tagChipStyle(index % 8, false)}>
        <TranslatedTag tag={tag} layout="stacked" missingTranslation="-" translationClassName="text-current opacity-70" />
      </span>)}</div>
    </section>)}
    {!Object.values(groups).some(tags => tags.length) && <p>{t('download.noImageTags')}</p>}
  </div>, document.body)
}
