import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  api,
  type CropWorkspaceItem,
} from '../../api/client'
import Button from '../Button'
import { useDialog } from '../Dialog'
import Modal from '../Modal'
import { useToast } from '../Toast'
import InpaintCanvas, {
  type InpaintCanvasHandle,
  type InpaintMode,
  type InpaintStroke,
  type LassoShape,
} from './InpaintCanvas'
import InpaintToolPanel from './InpaintToolPanel'
import {
  resolveMaskEdits,
  resolvePaintEdits,
  type InpaintHistoryEntry,
} from './inpaintHistory'
import {
  hasBlockingVisibleModal,
  INPAINT_TOOL_SHORTCUTS,
  isInpaintTextEntryTarget,
  useInpaintPreferences,
} from './inpaintPreferences'
import {
  saveInpaintEdits,
  type InpaintPersistedStage,
} from './saveInpaintEdits'

export interface SingleImageInpaintDialogProps {
  projectId: number
  versionId: number
  image: CropWorkspaceItem
  onClose: () => void
  onDirtyChange?: (dirty: boolean) => void
  onStageSaved?: (stage: InpaintPersistedStage) => void
}

function splitRel(name: string): { folder: string; filename: string } {
  const index = name.lastIndexOf('/')
  return {
    folder: index >= 0 ? name.slice(0, index) : '',
    filename: index >= 0 ? name.slice(index + 1) : name,
  }
}

export default function SingleImageInpaintDialog({
  projectId,
  versionId,
  image,
  onClose,
  onDirtyChange,
  onStageSaved,
}: SingleImageInpaintDialogProps) {
  const { t } = useTranslation()
  const { confirm } = useDialog()
  const { toast } = useToast()
  const canvasRef = useRef<InpaintCanvasHandle | null>(null)
  const editorRootRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useRef(true)
  const closingRef = useRef(false)
  const [currentImage, setCurrentImage] = useState(image)
  const [history, setHistory] = useState<InpaintHistoryEntry[]>([])
  const [redoHistory, setRedoHistory] = useState<InpaintHistoryEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [statusBarHost, setStatusBarHost] = useState<HTMLDivElement | null>(null)
  const {
    mode, setMode,
    tool, setTool,
    brush, setBrush,
    recentColors, setRecentColors,
  } = useInpaintPreferences()

  useEffect(() => () => { mountedRef.current = false }, [])

  const paintEdits = useMemo(() => resolvePaintEdits(history), [history])
  const maskEdits = useMemo(() => resolveMaskEdits(history), [history])
  const dirty = history.length > 0

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const imageUrl = useMemo(() => {
    const { folder, filename } = splitRel(currentImage.name)
    return api.versionThumbUrl(projectId, versionId, 'train', filename, folder, 0) +
      `&_=${currentImage.mtime}`
  }, [currentImage.mtime, currentImage.name, projectId, versionId])

  const maskBaseUrl = currentImage.mask_mtime == null
    ? null
    : `${api.maskUrl(projectId, versionId, currentImage.name)}&_=${currentImage.mask_mtime}`

  const pushEntry = useCallback((entry: InpaintHistoryEntry) => {
    setHistory((previous) => [...previous, entry])
    setRedoHistory([])
  }, [])

  const pushRecentColor = useCallback((color: string) => {
    setRecentColors((previous) => [
      color,
      ...previous.filter((item) => item !== color),
    ].slice(0, 8))
  }, [setRecentColors])

  const onStrokeEnd = useCallback((stroke: InpaintStroke) => {
    pushEntry({ kind: 'paint', edit: { type: 'stroke', stroke } })
    pushRecentColor(stroke.color)
  }, [pushEntry, pushRecentColor])

  const onMaskStrokeEnd = useCallback((stroke: InpaintStroke) => {
    pushEntry({ kind: 'mask', edit: { type: 'stroke', stroke } })
  }, [pushEntry])

  const onLassoCreate = useCallback((target: InpaintMode, shape: LassoShape) => {
    pushEntry(target === 'paint'
      ? { kind: 'paint', edit: { type: 'lasso', shape } }
      : { kind: 'mask', edit: { type: 'lasso', shape } })
  }, [pushEntry])

  const onLassoUpdate = useCallback((target: InpaintMode, shape: LassoShape) => {
    pushEntry({ kind: 'lasso-update', target, shape })
  }, [pushEntry])

  const undo = useCallback(() => {
    setHistory((previous) => {
      if (previous.length === 0) return previous
      const entry = previous[previous.length - 1]
      setRedoHistory((redo) => [...redo, entry])
      return previous.slice(0, -1)
    })
  }, [])

  const redo = useCallback(() => {
    setRedoHistory((previous) => {
      if (previous.length === 0) return previous
      const entry = previous[previous.length - 1]
      setHistory((entries) => [...entries, entry])
      return previous.slice(0, -1)
    })
  }, [])

  const clearAll = useCallback(() => {
    setHistory([])
    setRedoHistory([])
  }, [])

  const clearSavedKind = useCallback((kind: InpaintMode) => {
    setHistory((previous) => previous.filter((entry) => (
      entry.kind !== kind && !(entry.kind === 'lasso-update' && entry.target === kind)
    )))
    setRedoHistory([])
  }, [])

  const requestClose = useCallback(async () => {
    if (busy || closingRef.current) return
    if (!dirty) {
      onDirtyChange?.(false)
      onClose()
      return
    }
    closingRef.current = true
    try {
      const discard = await confirm(
        t('tagEdit.inpaintDiscardMessage'),
        {
          tone: 'danger',
          title: t('tagEdit.inpaintDiscardTitle'),
          okText: t('tagEdit.inpaintDiscardConfirm'),
          cancelText: t('tagEdit.inpaintKeepEditing'),
        },
      )
      if (!discard || !mountedRef.current) return
      onDirtyChange?.(false)
      onClose()
    } finally {
      closingRef.current = false
    }
  }, [busy, confirm, dirty, onClose, onDirtyChange, t])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const root = editorRootRef.current
      const ownerModal = root?.closest<HTMLElement>('[aria-modal="true"]') ?? null
      const active = document.activeElement
      if (
        !root || !ownerModal || !(active instanceof Node) || !ownerModal.contains(active) ||
        event.defaultPrevented || event.isComposing || hasBlockingVisibleModal(root)
      ) return

      if (event.code === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (canvasRef.current?.cancelTransientEdit()) return
        void requestClose()
        return
      }

      if (isInpaintTextEntryTarget(event.target)) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }

      const nextTool = INPAINT_TOOL_SHORTCUTS[event.code]
      if (
        !nextTool || nextTool === tool || event.repeat ||
        event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
      ) return
      event.preventDefault()
      setTool(nextTool)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [redo, requestClose, setTool, tool, undo])

  const saveAndClose = useCallback(async () => {
    if (busy || history.length === 0) return
    setBusy(true)
    try {
      const finalName = await saveInpaintEdits({
        projectId,
        versionId,
        image: currentImage,
        imageUrl,
        maskBaseUrl,
        paintEdits,
        maskEdits,
        exporters: {
          paint: () => canvasRef.current?.exportBlob() ?? Promise.resolve(null),
          mask: async () => await canvasRef.current?.exportMaskBlob() ?? null,
        },
        onStageSaved: async (stage) => {
          if (!mountedRef.current) return
          clearSavedKind(stage.kind)
          if (stage.kind === 'paint') {
            setCurrentImage((previous) => ({
              ...previous,
              name: stage.name,
              source: stage.result.origin,
              mtime: stage.result.mtime,
              size: stage.result.size,
              w: stage.result.w,
              h: stage.result.h,
              processed: true,
            }))
          } else {
            setCurrentImage((previous) => ({ ...previous, mask_mtime: stage.maskMtime }))
          }
          onStageSaved?.(stage)
        },
      })
      if (!mountedRef.current) return
      toast(t('preprocessInpaint.toastSaved', { name: finalName }), 'success')
      onDirtyChange?.(false)
      onClose()
    } catch (error) {
      if (mountedRef.current) toast(String(error), 'error')
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [
    busy, clearSavedKind, currentImage, history.length, imageUrl, maskBaseUrl,
    maskEdits, onClose, onDirtyChange, onStageSaved, paintEdits,
    projectId, t, toast, versionId,
  ])

  return (
    <Modal
      title={t('tagEdit.inpaintDialogTitle')}
      description={`${currentImage.name} · ${currentImage.w}×${currentImage.h}`}
      size="wide"
      onClose={() => { void requestClose() }}
      closeOnBackdrop={!busy}
      closeOnEscape={false}
      panelClassName="!w-[min(94vw,1600px)] !max-w-none h-[min(90dvh,1000px)]"
      bodyClassName="flex-1 !overflow-hidden"
      testId="single-image-inpaint-dialog"
      headerActions={(
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          onClick={() => { void requestClose() }}
          disabled={busy}
          aria-label={t('common.close')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </Button>
      )}
      footer={(
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={() => { void requestClose() }} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => { void saveAndClose() }}
            disabled={!dirty || busy}
            loading={busy}
          >
            {t('tagEdit.inpaintSaveAndClose')}
          </Button>
        </div>
      )}
    >
      <div ref={editorRootRef} className="flex h-full min-h-0 flex-col gap-2">
        <div className="flex shrink-0 items-center justify-end gap-1 border-b border-subtle pb-2">
          <Button variant="ghost" size="sm" onClick={undo} disabled={busy || history.length === 0} title="Ctrl+Z">
            {t('preprocessInpaint.undo')}
          </Button>
          <Button variant="ghost" size="sm" onClick={redo} disabled={busy || redoHistory.length === 0} title="Ctrl+Shift+Z">
            {t('preprocessInpaint.redo')}
          </Button>
          <Button variant="ghost" size="sm" onClick={clearAll} disabled={busy || history.length === 0}>
            {t('preprocessInpaint.clearActive')}
          </Button>
        </div>
        <div
          data-testid="single-image-inpaint-main"
          className={`grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_260px] ${busy ? 'pointer-events-none' : ''}`}
          aria-busy={busy}
        >
          <div className="min-h-[320px] min-w-0 overflow-hidden">
            <InpaintCanvas
              ref={canvasRef}
              imageUrl={imageUrl}
              imageW={currentImage.w}
              imageH={currentImage.h}
              mode={mode}
              paintEdits={paintEdits}
              maskEdits={maskEdits}
              maskBaseUrl={maskBaseUrl}
              brush={brush}
              onBrushAdjust={(next) => setBrush((previous) => ({ ...previous, ...next }))}
              tool={tool}
              onStrokeEnd={onStrokeEnd}
              onMaskStrokeEnd={onMaskStrokeEnd}
              onLassoCreate={onLassoCreate}
              onLassoUpdate={onLassoUpdate}
              onPickColor={(color) => {
                setBrush((previous) => ({ ...previous, color }))
                pushRecentColor(color)
              }}
              statusBarPortalTarget={statusBarHost}
            />
          </div>
          <InpaintToolPanel
            mode={mode}
            setMode={setMode}
            tool={tool}
            setTool={setTool}
            brush={brush}
            setBrush={setBrush}
            recentColors={recentColors}
          />
        </div>
        <div
          ref={setStatusBarHost}
          data-testid="single-image-inpaint-status-host"
          className="min-h-5 shrink-0"
        />
      </div>
    </Modal>
  )
}
