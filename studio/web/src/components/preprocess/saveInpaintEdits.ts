import {
  api,
  type CropWorkspaceItem,
  type InpaintSaveResult,
} from '../../api/client'
import {
  renderInpaintedBlob,
  renderMaskBlob,
  type MaskEdit,
  type PaintEdit,
} from './InpaintCanvas'

export type InpaintPersistedStage =
  | {
      kind: 'paint'
      previousName: string
      name: string
      result: InpaintSaveResult
    }
  | {
      kind: 'mask'
      name: string
      maskMtime: number | null
    }

export interface InpaintExporters {
  paint: () => Promise<Blob | null>
  mask: () => Promise<{ blob: Blob; coverage: number } | null>
}

export async function saveInpaintEdits({
  projectId,
  versionId,
  image,
  imageUrl,
  maskBaseUrl,
  paintEdits,
  maskEdits,
  exporters,
  onStageSaved,
}: {
  projectId: number
  versionId: number
  image: CropWorkspaceItem
  imageUrl: string
  maskBaseUrl: string | null
  paintEdits: PaintEdit[]
  maskEdits: MaskEdit[]
  exporters?: InpaintExporters
  onStageSaved?: (stage: InpaintPersistedStage) => void | Promise<void>
}): Promise<string> {
  let name = image.name

  if (paintEdits.length > 0) {
    const blob = exporters
      ? await exporters.paint()
      : await renderInpaintedBlob(imageUrl, image.w, image.h, paintEdits)
    if (!blob) throw new Error('canvas not ready')
    const previousName = name
    const result = await api.saveInpaintTrain(projectId, versionId, previousName, blob)
    name = result.name
    await onStageSaved?.({ kind: 'paint', previousName, name, result })
  }

  if (maskEdits.length > 0) {
    const exported = exporters
      ? await exporters.mask()
      : await renderMaskBlob(maskBaseUrl, image.w, image.h, maskEdits)
    let maskMtime: number | null = null
    if (exported === null) {
      if (image.mask_mtime != null) {
        await api.deleteMaskTrain(projectId, versionId, name)
      }
    } else {
      const result = await api.saveMaskTrain(projectId, versionId, name, exported.blob)
      maskMtime = result.mtime
    }
    await onStageSaved?.({ kind: 'mask', name, maskMtime })
  }

  return name
}

