import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  api,
  type HeadMaskProposalImage,
  type Job,
  type ModelsCatalog,
  type MaskTarget,
} from '../../api/client'
import { useToast } from '../Toast'
import { useEventStream } from '../../lib/useEventStream'
import Button from '../Button'
import { Input } from '../FormControl'
import { InfoButton } from '../InfoButton'
import { MASK_TARGETS, MASK_MODEL_LABELS, maskConfiguration, needsMaskReview, proposalTargets } from './autoMaskReview'

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
  ...props
}: Props) {
  return <MaskReviewPanel key={`${props.projectId}:${props.versionId}`} {...props} />
}

function MaskReviewPanel({
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
  const [targets, setTargets] = useState<MaskTarget[]>(['face_contour'])
  const [backgroundParams, setBackgroundParams] = useState({
    background_threshold: 0.5, background_protect_px: 0, background_feather_px: 0,
  })
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
  const mounted = useRef(true)
  const proposalRequest = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  jobIdRef.current = job?.id ?? null
  const currentParameters = { ...params, ...faceParams, ...backgroundParams, mask_targets: targets }
  const mismatch = proposal != null && maskConfiguration(proposal.parameters) !== maskConfiguration(currentParameters)
  const needsHead = targets.some((target) => target !== 'background')
  const modelKeys = (Object.keys(MASK_MODEL_LABELS) as (keyof typeof MASK_MODEL_LABELS)[]).filter((key) =>
    key === 'head_detector' ? needsHead : key === 'face_segmenter' ? targets.includes('face_contour') : targets.includes('background'))
  const missingModels = modelKeys.filter((key) => !catalog?.[key]?.valid)
  const modelReady = targets.length > 0 && missingModels.length === 0
  const parametersValid = (!needsHead || (params.confidence >= .01 && params.confidence <= .99 && params.iou_threshold >= .01 && params.iou_threshold <= .99))
    && (!targets.includes('head_box') || (params.padding_ratio >= 0 && params.padding_ratio <= 1 && params.feather_ratio >= 0 && params.feather_ratio <= .5))
    && (!targets.includes('face_contour') || (faceParams.face_confidence >= .01 && faceParams.face_confidence <= .99
      && faceParams.mask_threshold >= .01 && faceParams.mask_threshold <= .99 && Number.isInteger(faceParams.feather_px) && faceParams.feather_px >= 0 && faceParams.feather_px <= 3))
    && (!targets.includes('background') || (backgroundParams.background_threshold >= .01 && backgroundParams.background_threshold <= .99
      && Number.isInteger(backgroundParams.background_protect_px) && backgroundParams.background_protect_px >= 0 && backgroundParams.background_protect_px <= 64
      && Number.isInteger(backgroundParams.background_feather_px) && backgroundParams.background_feather_px >= 0 && backgroundParams.background_feather_px <= 32))

  const reloadCatalog = useCallback(() => {
    void api.getModelsCatalog().then((next) => { if (mounted.current) setCatalog(next) }).catch(() => {})
  }, [])

  const loadProposal = useCallback(async (jobId: number) => {
    const request = ++proposalRequest.current
    const result = await api.getHeadMaskProposals(projectId, versionId, jobId)
    if (!mounted.current || request !== proposalRequest.current || result.job_id !== jobId) return
    setProposal(result)
    const sameJob = proposalJobRef.current === jobId
    proposalJobRef.current = jobId
    setSelections((previous) => {
      if (sameJob) return previous
      return Object.fromEntries(
        result.images.map((image) => [image.name, image.regions.map((region) => region.id)]),
      )
    })
    void api.getHeadMaskApplications(projectId, versionId).then((r) => {
      if (mounted.current && request === proposalRequest.current) setApplications(r.applications)
    }).catch(() => {})
  }, [projectId, versionId])

  useEffect(() => {
    let active = true
    const request = proposalRequest.current
    reloadCatalog()
    void api.getPreprocessStatusTrain(projectId, versionId, 'head_mask').then((status) => {
      if (!active || !mounted.current || request !== proposalRequest.current || status.job?.project_id !== projectId || status.job.version_id !== versionId) return
      if (status.job?.id === ignoreJobId) return
      if (!isHeadMaskJob(status.job)) return
      const p = status.job.params_decoded
      if (status.job.status !== 'done' && !p?.mask_targets && p?.mask_mode !== 'face_contour') return
      setJob(status.job)
      if (status.job?.status === 'done') void loadProposal(status.job.id).catch((error) => toast(String(error), 'error'))
    }).catch(() => {})
    return () => { active = false }
  }, [projectId, versionId, reloadCatalog, loadProposal, toast, ignoreJobId])

  useEffect(() => {
    if (!downloadRequested || !Object.values(catalog?.downloads ?? {}).some((download) =>
      download.status === 'running' || download.status === 'pending')) return
    const timer = window.setInterval(reloadCatalog, 1000)
    return () => window.clearInterval(timer)
  }, [downloadRequested, catalog?.downloads, reloadCatalog])

  useEffect(() => { setReplacementPreview(null) }, [selections, replacementId, proposal?.job_id, mismatch])

  // SSE is the fast path. Polling is the recovery path for a sleeping browser,
  // a proxy that buffered events, or a reconnect that missed the terminal event.
  useEffect(() => {
    if (!job || (job.status !== 'pending' && job.status !== 'running')) return
    let active = true
    const poll = async () => {
      try {
        const latest = await api.getJob(job.id)
        if (!active || !mounted.current || latest.project_id !== projectId || latest.version_id !== versionId) return
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
  }, [job, loadProposal, t, toast, projectId, versionId])

  useEffect(() => {
    onStateChange(proposal ? { images: proposal.images, selections } : null)
  }, [proposal, selections, onStateChange])

  useEventStream((event) => {
    if (event.type === 'model_download_changed' && Object.keys(MASK_MODEL_LABELS).includes(String(event.key))) {
      reloadCatalog()
    }
    const currentJobId = jobIdRef.current
    if (!currentJobId || event.job_id !== currentJobId) return
    if (event.project_id != null && event.project_id !== projectId) return
    if (event.version_id != null && event.version_id !== versionId) return
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
    if (disabled || busy || running || !parametersValid) return
    if (unsavedCount > 0) {
      toast(t('preprocessInpaint.faceMask.saveFirst', { n: unsavedCount }), 'error')
      return
    }
    if (!modelReady) {
      toast(t('preprocessInpaint.faceMask.modelRequired'), 'error')
      return
    }
    if (scope === 'selected' && !activeName) return
    setBusy(true)
    proposalRequest.current++
    setProposal(null)
    setSelections({})
    setProgress({ done: 0, total: scope === 'selected' ? 1 : 0, heads: 0 })
    try {
      const next = await api.startHeadMaskDetection(projectId, versionId, {
        scope,
        ...(scope === 'selected' && activeName ? { filenames: [activeName] } : {}),
        ...currentParameters,
        model: 'builtin',
      })
      if (!mounted.current) return
      setJob(next)
      toast(t('preprocessInpaint.faceMask.detectStarted', { id: next.id }), 'success')
    } catch (error) {
      toast(String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const downloadModel = async (modelKey: keyof typeof MASK_MODEL_LABELS) => {
    setDownloadRequested(true)
    try {
      await api.startModelDownload({ model_id: modelKey })
      toast(t('preprocessInpaint.faceMask.downloadStarted'), 'success')
      reloadCatalog()
    } catch (error) {
      toast(String(error), 'error')
    }
  }

  const activeProposal = proposal?.images.find((image) => image.name === activeName) ?? null
  const selectedCount = Object.values(selections).reduce((total, ids) => total + ids.length, 0)
  const totalHeads = proposal?.images.reduce((total, image) => total + image.regions.length, 0) ?? 0
  const resultTargets = proposal ? proposalTargets(proposal.parameters) : []
  const undetected = useMemo(
    () => proposal?.images.filter(needsMaskReview).map((image) => image.name) ?? [],
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
    if (previewState !== 'ready' || mismatch || running) return
    if (!proposal || selectedCount === 0) return
    setBusy(true)
    try {
      const result = await api.applyHeadMaskProposals(
        projectId, versionId, proposal.job_id, selections,
      )
      if (!mounted.current) return
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
      if (!mounted.current) return
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
  const replacement = applications.find((a) => `${a.job_id}:${a.apply_id}` === replacementId)
  const ensureSaved = () => {
    if (disabled) return false
    if (unsavedCount === 0) return true
    toast(t('preprocessInpaint.faceMask.saveFirst', { n: unsavedCount }), 'error')
    return false
  }
  const previewReplacement = async () => {
    if (!ensureSaved() || mismatch || running || previewState !== 'ready' || !proposal || !replacement) return
    setBusy(true)
    try {
      const next = await api.previewHeadMaskReplacement(projectId, versionId, proposal.job_id, selections,
        { job_id: replacement.job_id, apply_id: replacement.apply_id })
      if (mounted.current) setReplacementPreview(next)
    } catch (error) { toast(String(error), 'error') } finally { setBusy(false) }
  }
  const confirmReplacement = async () => {
    if (!ensureSaved() || mismatch || running || previewState !== 'ready' || !proposal || !replacement || !replacementPreview) return
    setBusy(true)
    try {
      const result = await api.applyHeadMaskProposals(projectId, versionId, proposal.job_id, selections,
        { job_id: replacement.job_id, apply_id: replacement.apply_id })
      if (!mounted.current) return
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
        <span className={`text-xs ${modelReady ? 'text-ok' : 'text-warn'}`}>
          {targets.length === 0 ? t('preprocessInpaint.faceMask.selectTarget') : modelReady
            ? t('preprocessInpaint.faceMask.modelReady')
            : t('preprocessInpaint.faceMask.modelMissing')}
        </span>
      </div>
      <p className="text-xs text-fg-tertiary leading-relaxed m-0">
        {t('preprocessInpaint.faceMask.boundary')}
      </p>
      <fieldset disabled={busy || running} className="flex flex-col gap-2 border-0 p-0 min-w-0">
        <legend className="type-field-label mb-2">{t('preprocessInpaint.faceMask.targets')}</legend>
        {MASK_TARGETS.map((target) => <label key={target} className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={targets.includes(target)} onChange={() => setTargets((previous) =>
            previous.includes(target) ? previous.filter((value) => value !== target) : [...previous, target])} />
          {t(`preprocessInpaint.faceMask.target_${target}`)}
        </label>)}
      </fieldset>

      {missingModels.map((modelKey) => {
        const download = catalog?.downloads[modelKey]
        return <div key={modelKey} className="flex flex-col gap-1 min-w-0">
          <Button variant="secondary" size="sm" className="w-full whitespace-normal"
            disabled={download?.status === 'running' || download?.status === 'pending'}
            onClick={() => void downloadModel(modelKey)}>
            {t(`preprocessInpaint.faceMask.${MASK_MODEL_LABELS[modelKey]}`)}
            {download?.status === 'running' && ` · ${t('preprocessInpaint.faceMask.downloading')}`}
          </Button>
          {download?.message && <p role="alert" className="text-xs text-err m-0">{download.message}</p>}
          {download?.log_tail && <details className="text-xs"><summary>{t('preprocessInpaint.faceMask.prepareLog')}</summary>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap">{download.log_tail.join('\n')}</pre>
          </details>}
        </div>
      })}

      <details className="text-xs">
        <summary className="cursor-pointer text-fg-secondary">{t('preprocessInpaint.faceMask.parameters')}</summary>
        <fieldset disabled={busy || running} className="grid grid-cols-2 gap-2 mt-2 border-0 p-0 min-w-0">
          {needsHead && (targets.includes('head_box') ? ['confidence', 'iou_threshold', 'padding_ratio', 'feather_ratio'] as const
            : ['confidence', 'iou_threshold'] as const).map((key) => (
            <label key={key} className="flex min-w-0 flex-col gap-1 text-fg-tertiary">
              {t(`preprocessInpaint.faceMask.${key}`)}
              <Input controlSize="sm" mono type="number"
                min={key === 'confidence' || key === 'iou_threshold' ? .01 : 0}
                max={key === 'feather_ratio' ? .5 : key === 'padding_ratio' ? 1 : .99}
                step={.01} value={Number.isNaN(params[key]) ? '' : params[key]}
                onChange={(event) => setParams((current) => ({ ...current, [key]: event.target.valueAsNumber }))} />
            </label>
          ))}
          {targets.includes('face_contour') && (['face_confidence', 'mask_threshold', 'feather_px'] as const).map((key) => (
            <label key={key} className="flex min-w-0 flex-col gap-1 text-fg-tertiary">
              {t(`preprocessInpaint.faceMask.${key}`)}
              <Input controlSize="sm" mono type="number" value={Number.isNaN(faceParams[key]) ? '' : faceParams[key]}
                min={key === 'feather_px' ? 0 : .01} max={key === 'feather_px' ? 3 : .99}
                step={key === 'feather_px' ? 1 : .01}
                onChange={(event) => setFaceParams((p) => ({ ...p, [key]: event.target.valueAsNumber }))} />
            </label>
          ))}
          {targets.includes('background') && (['background_threshold', 'background_protect_px', 'background_feather_px'] as const).map((key) => (
            <div key={key} className="flex min-w-0 flex-col gap-1 text-fg-tertiary">
              <div className="flex items-center gap-1">
                <label htmlFor={key}>{t(`preprocessInpaint.faceMask.${key}`)}</label>
                <InfoButton ariaLabel={t(`preprocessInpaint.faceMask.${key}`)}>{t(`preprocessInpaint.faceMask.${key}Help`)}</InfoButton>
              </div>
              <Input id={key} controlSize="sm" mono type="number"
                value={Number.isNaN(backgroundParams[key]) ? '' : backgroundParams[key]}
                min={key === 'background_threshold' ? .01 : 0}
                max={key === 'background_threshold' ? .99 : key === 'background_protect_px' ? 64 : 32}
                step={key === 'background_threshold' ? .01 : 1}
                onChange={(event) => setBackgroundParams((p) => ({ ...p, [key]: event.target.valueAsNumber }))} />
            </div>
          ))}
        </fieldset>
        {!parametersValid && <p role="alert" className="text-xs text-err">{t('preprocessInpaint.faceMask.invalidParameters')}</p>}
      </details>

      <div className="grid grid-cols-2 gap-1.5">
        <Button type="button" variant="secondary" size="sm" className="justify-center"
          disabled={busy || running || !parametersValid || !modelReady}
          onClick={() => void startDetection('all')}>
          {t('preprocessInpaint.faceMask.detectAll')}
        </Button>
        <Button type="button" variant="secondary" size="sm" className="justify-center"
          disabled={busy || running || !parametersValid || !modelReady || !activeName}
          onClick={() => void startDetection('selected')}>
          {t('preprocessInpaint.faceMask.detectCurrent')}
        </Button>
      </div>

      {running && (
        <div className="rounded-sm bg-overlay px-2 py-1.5 text-xs text-fg-secondary">
          {t('preprocessInpaint.faceMask.progress', progress)}
          <Button type="button" variant="warning" size="xs" className="ml-2"
            onClick={() => job && void api.cancelJob(job.id)}>
            {t('common.cancel')}
          </Button>
        </div>
      )}

      {proposal && (
        <>
          {mismatch && <p role="status" className="text-xs text-warn m-0">
            {t('preprocessInpaint.faceMask.proposalModeMismatch')}
          </p>}
          {previewState !== 'ready' && <p role="alert" className="text-xs text-warn m-0">
            {t(`preprocessInpaint.faceMask.${previewState === 'error' ? 'previewFailed' : 'previewLoading'}`)}
          </p>}
          <div className="flex items-center gap-1.5 text-xs text-fg-secondary flex-wrap">
            <span>{t('preprocessInpaint.faceMask.combinedSummary', {
              images: proposal.images.length, heads: totalHeads, selected: selectedCount,
            })}</span>
            <Button type="button" variant="ghost" size="xs"
              onClick={() => onShowUndetected(undetected)}>
              {t('preprocessInpaint.faceMask.reviewFilter', { n: undetected.length })}
            </Button>
          </div>
          {proposal.stale_count > 0 && (
            <p className="m-0 text-xs text-err">
              {t('preprocessInpaint.faceMask.stale', { n: proposal.stale_count })}
            </p>
          )}
          {(activeProposal?.review_status === 'needs_review' || activeProposal?.review_status === 'no_face') && (
            <p role="status" className="text-xs text-warn m-0">{t('preprocessInpaint.faceMask.needsReview')}</p>
          )}
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" disabled={busy || running} onClick={() => setActiveSelection(true)}>
              {t('preprocessInpaint.faceMask.selectCurrent')}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy || running} onClick={() => setActiveSelection(false)}>
              {t('preprocessInpaint.faceMask.clearCurrent')}
            </Button>
          </div>
          <div className="flex flex-col gap-2 max-h-64 overflow-auto">
            {resultTargets.map((target) => {
              const regions = activeProposal?.regions.filter((region) => (region.target ?? resultTargets[0]) === target) ?? []
              const total = proposal.images.reduce((count, image) => count + image.regions.filter((r) => (r.target ?? resultTargets[0]) === target).length, 0)
              const reviewImages = proposal.images.filter((image) => {
                const status = image.target_statuses?.[target]
                return status ? status.status !== 'done' && status.reason !== 'no_background' : needsMaskReview(image)
              }).map((image) => image.name)
              const status = activeProposal?.target_statuses?.[target]
              return <section key={target} aria-label={t(`preprocessInpaint.faceMask.target_${target}`)} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-1 text-xs">
                  <span className="font-medium">{t(`preprocessInpaint.faceMask.target_${target}`)} · {total}</span>
                  {reviewImages.length > 0 && <Button variant="ghost" size="xs" onClick={() => onShowUndetected(reviewImages)}>
                    {t('preprocessInpaint.faceMask.reviewFilter', { n: reviewImages.length })}
                  </Button>}
                </div>
                {status && status.reason !== 'ready' && <p role="status" className="text-xs text-warn m-0">
                  {t(`preprocessInpaint.faceMask.reason_${status.reason}`, { defaultValue: status.reason })}
                  {status.error && <span className="block break-words">{status.error}</span>}
                </p>}
                {!regions.length && <span className="text-xs text-fg-tertiary">{t('preprocessInpaint.faceMask.noneCurrent')}</span>}
                {regions.map((region, index) => <label key={region.id} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" disabled={busy || running}
                    checked={(selections[activeProposal!.name] ?? []).includes(region.id)} onChange={() => toggleRegion(region.id)} />
                  <span>{target === 'background'
                    ? t('preprocessInpaint.faceMask.backgroundRegion', { percent: ((region.coverage ?? 0) * 100).toFixed(1) })
                    : t(`preprocessInpaint.faceMask.${target === 'face_contour' ? 'faceRegion' : 'region'}`, {
                      n: index + 1, score: Math.round((region.score ?? 0) * 100),
                    })}</span>
                </label>)}
              </section>
            })}
          </div>
          <div className="flex flex-col gap-1.5">
            <Button type="button" variant="primary" size="sm" className="justify-center"
              disabled={busy || running || mismatch || previewState !== 'ready' || selectedCount === 0 || proposal.stale_count > 0}
              onClick={() => void apply()}>
              {t('preprocessInpaint.faceMask.applySelected', { n: selectedCount })}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="justify-center"
              disabled={busy || running || !proposal.undo_available}
              onClick={() => void undoApply()}>
              {t('preprocessInpaint.faceMask.undoApply')}
            </Button>
          </div>
          {(
            <details className="text-xs border-t border-subtle pt-2">
              <summary>{t('preprocessInpaint.faceMask.replaceTitle')}</summary>
              <select aria-label={t('preprocessInpaint.faceMask.replaceSource')} className="input text-xs w-full mt-2"
                disabled={busy || running} value={replacementId} onChange={(event) => setReplacementId(event.target.value)}>
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
              <Button type="button" variant="secondary" size="sm" className="mt-2" disabled={busy || running || mismatch || previewState !== 'ready' || !replacement || selectedCount === 0}
                onClick={() => void previewReplacement()}>{t('preprocessInpaint.faceMask.replacePreview')}</Button>
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
                <Button type="button" variant="primary" size="sm" className="mt-2" disabled={busy || running || mismatch || previewState !== 'ready' || replacementPreview.images.length === 0}
                  onClick={() => void confirmReplacement()}>{t('preprocessInpaint.faceMask.replaceConfirm')}</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setReplacementPreview(null)}>{t('common.cancel')}</Button>
              </section>}
            </details>
          )}
        </>
      )}
    </fieldset>
  )
}
