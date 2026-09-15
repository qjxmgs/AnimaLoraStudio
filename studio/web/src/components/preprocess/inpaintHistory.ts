import type {
  InpaintMode,
  LassoShape,
  MaskEdit,
  PaintEdit,
} from './InpaintCanvas'

export type InpaintHistoryEntry =
  | { kind: 'paint'; edit: PaintEdit }
  | { kind: 'mask'; edit: MaskEdit }
  | { kind: 'lasso-update'; target: InpaintMode; shape: LassoShape }
  | { kind: 'lasso-delete'; target: InpaintMode; shapeId: string }

function latestLassoShapes(
  history: InpaintHistoryEntry[],
  target: InpaintMode,
): Map<string, LassoShape> {
  const latest = new Map<string, LassoShape>()
  for (const entry of history) {
    if (entry.kind === 'lasso-update' && entry.target === target) {
      latest.set(entry.shape.id, entry.shape)
    }
  }
  return latest
}

function deletedLassoIds(
  history: InpaintHistoryEntry[],
  target: InpaintMode,
): Set<string> {
  const deleted = new Set<string>()
  for (const entry of history) {
    if (entry.kind === 'lasso-delete' && entry.target === target) {
      deleted.add(entry.shapeId)
    }
  }
  return deleted
}

export function resolvePaintEdits(history: InpaintHistoryEntry[]): PaintEdit[] {
  const latest = latestLassoShapes(history, 'paint')
  const deleted = deletedLassoIds(history, 'paint')
  const edits: PaintEdit[] = []
  for (const entry of history) {
    if (entry.kind !== 'paint') continue
    if (entry.edit.type === 'lasso' && deleted.has(entry.edit.shape.id)) continue
    edits.push(entry.edit.type === 'lasso'
      ? { ...entry.edit, shape: latest.get(entry.edit.shape.id) ?? entry.edit.shape }
      : entry.edit)
  }
  return edits
}

export function resolveMaskEdits(history: InpaintHistoryEntry[]): MaskEdit[] {
  const latest = latestLassoShapes(history, 'mask')
  const deleted = deletedLassoIds(history, 'mask')
  const edits: MaskEdit[] = []
  for (const entry of history) {
    if (entry.kind !== 'mask') continue
    if (entry.edit.type === 'lasso' && deleted.has(entry.edit.shape.id)) continue
    edits.push(entry.edit.type === 'lasso'
      ? { ...entry.edit, shape: latest.get(entry.edit.shape.id) ?? entry.edit.shape }
      : entry.edit)
  }
  return edits
}
