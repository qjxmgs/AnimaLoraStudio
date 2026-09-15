import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type CropWorkspaceItem } from '../../api/client'
import type { MaskEdit, PaintEdit } from './InpaintCanvas'
import { saveInpaintEdits, type InpaintPersistedStage } from './saveInpaintEdits'

const image: CropWorkspaceItem = {
  name: '1_data/source.jpg',
  source: 'source.jpg',
  w: 320,
  h: 240,
  mtime: 1,
  size: 10,
  processed: false,
  mask_mtime: 5,
}

const stroke = {
  color: '#ffffff',
  size: 20,
  hardness: 1,
  points: [{ x: 10, y: 10 }],
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(api, 'saveInpaintTrain').mockResolvedValue({
    name: '1_data/source.png',
    origin: 'source.jpg',
    w: 320,
    h: 240,
    mtime: 10,
    size: 20,
  })
  vi.spyOn(api, 'saveMaskTrain').mockResolvedValue({
    name: '1_data/source.png',
    mtime: 11,
    size: 4,
  })
  vi.spyOn(api, 'deleteMaskTrain').mockResolvedValue({ deleted: true })
})

describe('saveInpaintEdits', () => {
  it('saves paint first and targets the renamed image when saving the mask', async () => {
    const paintEdits: PaintEdit[] = [{ type: 'stroke', stroke }]
    const maskEdits: MaskEdit[] = [{ type: 'stroke', stroke }]
    const stages: InpaintPersistedStage[] = []

    const name = await saveInpaintEdits({
      projectId: 7,
      versionId: 11,
      image,
      imageUrl: '/image.jpg',
      maskBaseUrl: '/mask',
      paintEdits,
      maskEdits,
      exporters: {
        paint: async () => new Blob(['paint']),
        mask: async () => ({ blob: new Blob(['mask']), coverage: 0.2 }),
      },
      onStageSaved: (stage) => { stages.push(stage) },
    })

    expect(name).toBe('1_data/source.png')
    expect(api.saveInpaintTrain).toHaveBeenCalledWith(7, 11, '1_data/source.jpg', expect.any(Blob))
    expect(api.saveMaskTrain).toHaveBeenCalledWith(7, 11, '1_data/source.png', expect.any(Blob))
    expect(stages.map((stage) => stage.kind)).toEqual(['paint', 'mask'])
    expect(stages[1]).toMatchObject({ kind: 'mask', name: '1_data/source.png', maskMtime: 11 })
  })

  it('deletes an existing mask when the edited result has no coverage', async () => {
    const maskEdits: MaskEdit[] = [{ type: 'stroke', stroke: { ...stroke, erase: true } }]
    const stages: InpaintPersistedStage[] = []

    await saveInpaintEdits({
      projectId: 7,
      versionId: 11,
      image,
      imageUrl: '/image.jpg',
      maskBaseUrl: '/mask',
      paintEdits: [],
      maskEdits,
      exporters: {
        paint: async () => null,
        mask: async () => null,
      },
      onStageSaved: (stage) => { stages.push(stage) },
    })

    expect(api.deleteMaskTrain).toHaveBeenCalledWith(7, 11, image.name)
    expect(api.saveMaskTrain).not.toHaveBeenCalled()
    expect(stages).toEqual([{ kind: 'mask', name: image.name, maskMtime: null }])
  })
})

