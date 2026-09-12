import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  api,
  type HeadMaskProposalImage,
  type Job,
  type ModelsCatalog,
} from '../../api/client'
import { useToast } from '../Toast'
import { useEventStream } from '../../lib/useEventStream'

export interface AutoHeadMaskState {
  images: HeadMaskProposalImage[]
  selections: Record<string, string[]>
}

interface Props {
  projectId: number
  versionId: number
  activeName: string | null
  unsavedCount: number
  previewState?: 'loading' | 'ready' | 'error'
  disabled?: boolean
  ignoreJobId?: number
  onBusyChange?: (busy: boolean) => void
  onStateChange: (state: AutoHeadMaskState | null) => void
  onShowUndetected: (names: string[]) => void
  onWorkspaceChanged: () => Promise<void>
}

function isHeadMaskJob(job: Job | null): boolean {
  if (!job) return false
  let params = job.params_decoded
  if (!params && typeof job.params === 'string') {
    try { params = JSON.parse(job.params) as Record<string, unknown> } catch { return false }
  }
  return params?.stage === 'head_mask'
}

export default function FaceContourMaskPanel({
  projectId,
  versionId,
  activeName,
  unsavedCount,
  previewState = 'ready',
  disabled = false,
  ignoreJobId,
  onBusyChange,
  onStateChange,
  onShowUndetected,
  onWorkspaceChanged,
}: Props) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [catalog, setCatalog] = useState<ModelsCatalog | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [proposal, setProposal] = useState<Awaited<ReturnType<typeof api.getHeadMaskProposals>> | null>(null)
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'face_contour' | 'head_box'>('face_contour')
  const [applications, setApplications] = useState<Awaited<ReturnType<typeof api.getHeadMaskApplications>>['applications']>([])
  const [replacementId, setReplacementId] = useState('')
  const [replacementPreview, setReplacementPreview] = useState<Awaited<ReturnType<typeof api.previewHeadMaskReplacement>> | null>(null)
  const [faceParams, setFaceParams] = useState({ face_confidence: 0.25, mask_threshold: 0.5, feather_px: 0 })
  const [downloadRequested, setDownloadRequested] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0, heads: 0 })
  const [params, setParams] = useState({
    confidence: 0.413,
    iou_threshold: 0.7,
    padding_ratio: 0.10,
    feather_ratio: 0.03,
  })
  const jobIdRef = useRef<number | null>(null)
  const proposalJobRef = useRef<number | null>(null)
  jobIdRef.current = job?.id ?? null

  const reloadCatalog = useCallback(() => {
    void api.getModelsCatalog().then(setCatalog).catch(() => setCatalog(null))
  }, [])

  const loadProposal = useCallback(async (jobId: number) => {
    const result = await api.getHeadMaskProposals(projectId, versionId, jobId)
    setProposal(result)
    const sameJob = proposalJobRef.current === jobId
    proposalJobRef.current = jobId
    setSelections((previous) => {
      if (sameJob) return previous
      return Object.fromEntries(
        result.images.map((image) => [image.name, image.regions.map((region) => region.id)]),
      )
    })
    void api.getHeadMaskApplications(projectId, versionId).then((r) => setApplications(r.applications)).catch(() => setApplications([]))
  }, [projectId, versionId])

  useEffect(() => {
    reloadCatalog()
    void api.getPreprocessStatusTrain(projectId, versionId, 'head_mask').then((status) => {
      if (status.job?.id === ignoreJobId) return
      if (!isHeadMaskJob(status.job)) return
      setJob(status.job)
      if (status.job?.status === 'done') void loadProposal(status.job.id).catch((error) => toast(String(error), 'error'))
    }).catch(() => {})
  }, [projectId, versionId, reloadCatalog, loadProposal, toast, ignoreJobId])

  useEffect(() => {
    if (!downloadRequested || (catalog?.head_detector?.valid && catalog?.face_segmenter?.valid)) return
    const timer = window.setInterval(reloadCatalog, 1000)
    return () => window.clearInterval(timer)
  }, [downloadRequested, catalog?.head_detector?.valid, catalog?.face_segmenter?.valid, reloadCatalog])

  useEffect(() => { setReplacementPreview(null) }, [selections, replacementId, proposal?.job_id])

  // SSE is the fast path. Polling is the recovery path for a sleeping browser,
  // a proxy that buffered events, or a reconnect that missed the terminal event.
  useEffect(() => {
    if (!job || (job.status !== 'pending' && job.status !== 'running')) return
    let active = true
    const poll = async () => {
      try {
        const latest = await api.getJob(job.id)
        if (!active) return
        setJob(latest)
        if (latest.status === 'done') await loadProposal(latest.id)
        else if (latest.status === 'failed') toast(t('preprocessInpaint.faceMask.detectFailed'), 'error')
        else if (latest.status === 'canceled') toast(t('preprocessInpaint.faceMask.detectCanceled'), 'info')
      } catch {
        // A transient status read must not replace a still-running job with an error.
      }
    }
    const timer = window.setInterval(() => { void poll() }, 1500)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [job, loadProposal, t, toast])

  useEffect(() => {
    onStateChange(proposal ? { images: proposal.images, selections } : null)
  }, [proposal, selections, onStateChange])

  useEventStream((event) => {
    if (event.type === 'model_download_changed' && ['head_detector', 'face_segmenter'].includes(String(event.key))) {
      reloadCatalog()
    }
    const currentJobId = jobIdRef.current
    if (!currentJobId || event.job_id !== currentJobId) return
    if (event.type === 'head_mask_progress') {
      setProgress((current) => ({
        done: Number(event.idx ?? current.done),
        total: Number(event.total ?? current.total),
        heads: current.heads + (event.status === 'done' ? Number(event.detections ?? 0) : 0),
      }))
    } else if (event.type === 'job_state_changed') {
      const status = String(event.status) as Job['status']
      setJob((current) => current ? { ...current, status } : current)
      if (status === 'done') {
        void loadProposal(currentJobId).catch((error) => toast(String(error), 'error'))
      } else if (status === 'failed') {
        toast(t('preprocessInpaint.faceMask.detectFailed'), 'error')
      } else if (status === 'canceled') {
        toast(t('preprocessInpaint.faceMask.detectCanceled'), 'info')
      }
    }
  })

  const startDetection = async (scope: 'all' | 'selected') => {
    if (disabled) return
    if (unsavedCount > 0) {
      toast(t('preprocessInpaint.faceMask.saveFirst', { n: unsavedCount }), 'error')
      return
    }
    if (!catalog?.head_detector?.valid || (mode === 'face_contour' && !catalog?.face_segmenter?.valid)) {
      toast(t('preprocessInpaint.faceMask.modelRequired'), 'error')
      return
    }
    if (scope === 'selected' && !activeName) return
    setBusy(true)
    setProposal(null)
    setSelections({})
    setProgress({ done: 0, total: scope === 'selected' ? 1 : 0, heads: 0 })
    try {
      const next = await api.startHeadMaskDetection(projectId, versionId, {
        scope,
        ...(scope === 'selected' && activeName ? { filenames: [activeName] } : {}),
        ...params,
        mask_mode: mode,
        model: 'builtin',
        ...(mode === 'face_contour' ? faceParams : {}),
      })
      setJob(next)
      toast(t('preprocessInpaint.faceMask.detectStarted', { id: next.id }), 'success')
    } catch (error) {
      toast(String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const downloadModel = async () => {
    setDownloadRequested(true)
    try {
      await api.startModelDownload({ model_id: catalog?.head_detector?.valid ? 'face_segmenter' : 'head_detector' })
      toast(t('preprocessInpaint.faceMask.downloadStarted'), 'success')
      reloadCatalog()
    } catch (error) {
      toast(String(error), 'error')
    }
  }

  const activeProposal = proposal?.images.find((image) => image.name === activeName) ?? null
  const selectedCount = Object.values(selections).reduce((total, ids) => total + ids.length, 0)
  const totalHeads = proposal?.images.reduce((total, image) => total + image.regions.length, 0) ?? 0
  const faceProposal = proposal?.parameters.mask_mode === 'face_contour'
  const undetected = useMemo(
    () => proposal?.images.filter((image) => image.regions.length === 0 || image.review_status === 'needs_review').map((image) => image.name) ?? [],
    [proposal],
  )

  const setActiveSelection = (all: boolean) => {
    if (!activeProposal) return
    setSelections((current) => ({
      ...current,
      [activeProposal.name]: all ? activeProposal.regions.map((region) => region.id) : [],
    }))
  }

  const toggleRegion = (regionId: string) => {
    if (!activeProposal) return
    setSelections((current) => {
      const existing = current[activeProposal.name] ?? []
      return {
        ...current,
        [activeProposal.name]: existing.includes(regionId)
          ? existing.filter((id) => id !== regionId)
          : [...existing, regionId],
      }
    })
  }

  const apply = async () => {
    if (!ensureSaved()) return
    if (previewState !== 'ready') return
    if (!proposal || selectedCount === 0) return
    setBusy(true)
    try {
      const result = await api.applyHeadMaskProposals(
        projectId, versionId, proposal.job_id, selections,
      )
      toast(t('preprocessInpaint.faceMask.applied', { n: result.applied }), 'success')
      await onWorkspaceChanged()
      await loadProposal(proposal.job_id)
    } catch (error) {
      toast(String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const undoApply = async () => {
    if (!ensureSaved()) return
    if (!proposal) return
    setBusy(true)
    try {
      const result = await api.undoHeadMaskApply(projectId, versionId, proposal.job_id)
      toast(t('preprocessInpaint.faceMask.undone', { n: result.undone }), 'success')
      await onWorkspaceChanged()
      await loadProposal(proposal.job_id)
    } catch (error) {
      toast(String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const running = job?.status === 'pending' || job?.status === 'running'
  useEffect(() => { onBusyChange?.(busy || running) }, [busy, running, onBusyChange])
  const modelReady = catalog?.head_detector?.valid === true && (mode === 'head_box' || catalog?.face_segmenter?.valid === true)
  const modelKey = catalog?.head_detector?.valid ? 'face_segmenter' : 'head_detector'
  const download = catalog?.downloads[modelKey]
  const replacement = applications.find((a) => `${a.job_id}:${a.apply_id}` === replacementId)
  const ensureSaved = () => {
    if (disabled) return false
    if (unsavedCount === 0) return true
    toast(t('preprocessInpaint.faceMask.saveFirst', { n: unsavedCount }), 'error')
    return false
  }
  const previewReplacement = async () => {
    if (!ensureSaved() || previewState !== 'ready' || !proposal || !replacement) return
    setBusy(true)
    try {
      setReplacementPreview(await api.previewHeadMaskReplacement(projectId, versionId, proposal.job_id, selections,
        { job_id: replacement.job_id, apply_id: replacement.apply_id }))
    } catch (error) { toast(String(error), 'error') } finally { setBusy(false) }
  }
  const confirmReplacement = async () => {
    if (!ensureSaved() || previewState !== 'ready' || !proposal || !replacement || !replacementPreview) return
    setBusy(true)
    try {
      const result = await api.applyHeadMaskProposals(projectId, versionId, proposal.job_id, selections,
        { job_id: replacement.job_id, apply_id: replacement.apply_id })
      toast(t('preprocessInpaint.faceMask.applied', { n: result.applied }), 'success')
      setReplacementPreview(null)
      await onWorkspaceChanged()
      await loadProposal(proposal.job_id)
    } catch (error) { toast(String(error), 'error') } finally { setBusy(false) }
  }

  return (
    <fieldset disabled={disabled} className="flex flex-col gap-2 border-0 border-t border-subtle p-0 pt-2 mt-1 min-w-0" data-testid="auto-head-mask-panel">
      <div className="flex items-center justify-between gap-2">
        <h4 className="caption">{t('preprocessInpaint.faceMask.title')}</h4>
        <span className={`text-[10px] ${modelReady ? 'text-ok' : 'text-warn'}`}>
          {modelReady
            ? t('preprocessInpaint.faceMask.modelReady')
            : t('preprocessInpaint.faceMask.modelMissing')}
        </span>
      </div>
      <p className="text-[11px] text-fg-tertiary leading-relaxed m-0">
        {t('preprocessInpaint.faceMask.boundary')}
      </p>
      <label className="text-xs flex flex-col gap-1">
        {t('preprocessInpaint.faceMask.mode')}
        <select className="input text-xs" value={mode} disabled={busy || running}
          onChange={(event) => setMode(event.target.value as typeof mode)}>
          <option value="face_contour">{t('preprocessInpaint.faceMask.faceMode')}</option>
          <option value="head_box">{t('preprocessInpaint.faceMask.boxMode')}</option>
        </select>
      </label>

      {!modelReady && (
        <button
          type="button"
          className="btn btn-secondary btn-sm justify-center"
          disabled={download?.status === 'running'}
          onClick={() => void downloadModel()}
        >
          {download?.status === 'running'
            ? t('preprocessInpaint.faceMask.downloading')
            : t(`preprocessInpaint.faceMask.${modelKey === 'face_segmenter' ? 'prepareFaceModel' : 'downloadModel'}`)}
        </button>
      )}
      {download?.message && <p role="alert" className="text-xs text-err m-0">{download.message}</p>}
      {download?.log_tail && <details className="text-xs"><summary>{t('preprocessInpaint.faceMask.prepareLog')}</summary>
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap">{download.log_tail.join('\n')}</pre>
      </details>}

      <details className="text-[11px]">
        <summary className="cursor-pointer text-fg-secondary">
          {t('preprocessInpaint.faceMask.parameters')}
        </summary>
        <div className="grid grid-cols-2 gap-1.5 mt-1.5">
          {(mode === 'head_box' ? ['confidence', 'iou_threshold', 'padding_ratio', 'feather_ratio'] as const
            : ['confidence', 'iou_threshold'] as const).map((key) => (
            <label key={key} className="flex flex-col gap-0.5 text-fg-tertiary">
              {t(`preprocessInpaint.faceMask.${key}`)}
              <input
                className="input input-mono text-xs"
                type="number"
                min={0} max={key === 'feather_ratio' ? 0.5 : 1}
                step={0.01}
                value={params[key]}
                onChange={(event) => setParams((current) => ({
                  ...current,
                  [key]: Number(event.target.value),
                }))}
              />
            </label>
          ))}
          {mode === 'face_contour' && (['face_confidence', 'mask_threshold', 'feather_px'] as const).map((key) => (
            <label key={key} className="flex flex-col gap-0.5 text-fg-tertiary">
              {t(`preprocessInpaint.faceMask.${key}`)}
              <input className="input input-mono text-xs" type="number" value={faceParams[key]}
                min={key === 'feather_px' ? 0 : 0.01} max={key === 'feather_px' ? 3 : 0.99}
                step={key === 'feather_px' ? 1 : 0.01}
                onChange={(event) => setFaceParams((p) => ({ ...p, [key]: Number(event.target.value) }))} />
            </label>
          ))}
        </div>
      </details>

      <div className="grid grid-cols-2 gap-1.5">
        <button type="button" className="btn btn-secondary btn-sm justify-center"
          disabled={busy || running || !modelReady}
          onClick={() => void startDetection('all')}>
          {t('preprocessInpaint.faceMask.detectAll')}
        </button>
        <button type="button" className="btn btn-secondary btn-sm justify-center"
          disabled={busy || running || !modelReady || !activeName}
          onClick={() => void startDetection('selected')}>
          {t('preprocessInpaint.faceMask.detectCurrent')}
        </button>
      </div>

      {running && (
        <div className="rounded-sm bg-overlay px-2 py-1.5 text-[11px] text-fg-secondary">
          {t('preprocessInpaint.faceMask.progress', progress)}
          <button type="button" className="ml-2 text-err underline"
            onClick={() => job && void api.cancelJob(job.id)}>
            {t('common.cancel')}
          </button>
        </div>
      )}

      {proposal && (
        <>
          {(proposal.parameters.mask_mode ?? 'head_box') !== mode && <p role="status" className="text-xs text-warn m-0">
            {t('preprocessInpaint.faceMask.proposalModeMismatch')}
          </p>}
          {previewState !== 'ready' && <p role="alert" className="text-xs text-warn m-0">
            {t(`preprocessInpaint.faceMask.${previewState === 'error' ? 'previewFailed' : 'previewLoading'}`)}
          </p>}
          <div className="flex items-center gap-1.5 text-[11px] text-fg-secondary flex-wrap">
            <span>{t(`preprocessInpaint.faceMask.${faceProposal ? 'faceSummary' : 'summary'}`, {
              images: proposal.images.length, heads: totalHeads, selected: selectedCount,
            })}</span>
            <button type="button" className="underline text-accent"
              onClick={() => onShowUndetected(undetected)}>
              {t(`preprocessInpaint.faceMask.${faceProposal ? 'faceUndetected' : 'showUndetected'}`, { n: undetected.length })}
            </button>
          </div>
          {proposal.stale_count > 0 && (
            <p className="m-0 text-[11px] text-err">
              {t('preprocessInpaint.faceMask.stale', { n: proposal.stale_count })}
            </p>
          )}
          {(activeProposal?.review_status === 'needs_review' || activeProposal?.review_status === 'no_face') && (
            <p role="status" className="text-xs text-warn m-0">{t('preprocessInpaint.faceMask.needsReview')}</p>
          )}
          <div className="flex items-center gap-1">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setActiveSelection(true)}>
              {t('preprocessInpaint.faceMask.selectCurrent')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setActiveSelection(false)}>
              {t('preprocessInpaint.faceMask.clearCurrent')}
            </button>
          </div>
          <div className="flex flex-col gap-1 max-h-28 overflow-auto">
            {!activeProposal || activeProposal.regions.length === 0 ? (
              <span className="text-[11px] text-fg-tertiary">
                {t('preprocessInpaint.faceMask.noneCurrent')}
              </span>
            ) : activeProposal.regions.map((region, index) => (
              <label key={region.id} className="flex items-center gap-1.5 text-[11px]">
                <input type="checkbox"
                  checked={(selections[activeProposal.name] ?? []).includes(region.id)}
                  onChange={() => toggleRegion(region.id)} />
                <span>{t(`preprocessInpaint.faceMask.${faceProposal ? 'faceRegion' : 'region'}`, {
                  n: index + 1, score: Math.round(region.score * 100),
                })}</span>
              </label>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <button type="button" className="btn btn-primary btn-sm justify-center"
              disabled={busy || previewState !== 'ready' || selectedCount === 0 || proposal.stale_count > 0}
              onClick={() => void apply()}>
              {t('preprocessInpaint.faceMask.applySelected', { n: selectedCount })}
            </button>
            <button type="button" className="btn btn-ghost btn-sm justify-center"
              disabled={busy || !proposal.undo_available}
              onClick={() => void undoApply()}>
              {t('preprocessInpaint.faceMask.undoApply')}
            </button>
          </div>
          {proposal.parameters.mask_mode === 'face_contour' && (
            <details className="text-xs border-t border-subtle pt-2">
              <summary>{t('preprocessInpaint.faceMask.replaceTitle')}</summary>
              <select aria-label={t('preprocessInpaint.faceMask.replaceSource')} className="input text-xs w-full mt-2"
                value={replacementId} onChange={(event) => setReplacementId(event.target.value)}>
                <option value="">{t('preprocessInpaint.faceMask.replaceSource')}</option>
                {applications.filter((a) => a.job_id !== proposal.job_id).map((a) => (
                  <option key={a.apply_id} value={`${a.job_id}:${a.apply_id}`}>
                    #{a.job_id} · {a.images.filter((i) => i.eligible).length}/{a.images.length}
                  </option>
                ))}
              </select>
              {replacement && <ul className="my-2 max-h-24 overflow-auto pl-4">
                {replacement.images.map((i) => <li key={i.name} className={i.eligible ? 'text-fg-secondary' : 'text-err'}>
                  {i.name} · {i.eligible ? t('preprocessInpaint.faceMask.replaceEligible') : i.reason}
                </li>)}
              </ul>}
              <button type="button" className="btn btn-secondary btn-sm mt-2" disabled={busy || previewState !== 'ready' || !replacement || selectedCount === 0}
                onClick={() => void previewReplacement()}>{t('preprocessInpaint.faceMask.replacePreview')}</button>
              {replacementPreview && <section aria-label={t('preprocessInpaint.faceMask.replacePreview')} className="mt-2">
                <p>{t('preprocessInpaint.faceMask.replaceWarning')}</p>
                <div className="max-h-72 overflow-auto">
                  {replacementPreview.images.map((i) => <details key={i.name} open={i.name === activeName}>
                    <summary className="break-all">{i.name}</summary>
                    <p>{t('preprocessInpaint.faceMask.replaceDiff', { restored: i.restored_pixels, ignored: i.ignored_pixels })}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <figure className="m-0"><img src={i.before_url} alt={t('preprocessInpaint.faceMask.before')} /><figcaption>{t('preprocessInpaint.faceMask.before')}</figcaption></figure>
                      <figure className="m-0"><img src={i.after_url} alt={t('preprocessInpaint.faceMask.after')} /><figcaption>{t('preprocessInpaint.faceMask.after')}</figcaption></figure>
                    </div>
                  </details>)}
                </div>
                <button type="button" className="btn btn-primary btn-sm mt-2" disabled={busy || previewState !== 'ready' || replacementPreview.images.length === 0}
                  onClick={() => void confirmReplacement()}>{t('preprocessInpaint.faceMask.replaceConfirm')}</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReplacementPreview(null)}>{t('common.cancel')}</button>
              </section>}
            </details>
          )}
        </>
      )}
    </fieldset>
  )
}
