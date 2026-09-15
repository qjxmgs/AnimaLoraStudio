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

export function resolvePaintEdits(history: InpaintHistoryEntry[]): PaintEdit[] {
  const latest = latestLassoShapes(history, 'paint')
  const edits: PaintEdit[] = []
  for (const entry of history) {
    if (entry.kind !== 'paint') continue
    edits.push(entry.edit.type === 'lasso'
      ? { ...entry.edit, shape: latest.get(entry.edit.shape.id) ?? entry.edit.shape }
      : entry.edit)
  }
  return edits
}

export function resolveMaskEdits(history: InpaintHistoryEntry[]): MaskEdit[] {
  const latest = latestLassoShapes(history, 'mask')
  const edits: MaskEdit[] = []
  for (const entry of history) {
    if (entry.kind !== 'mask') continue
    edits.push(entry.edit.type === 'lasso'
      ? { ...entry.edit, shape: latest.get(entry.edit.shape.id) ?? entry.edit.shape }
      : entry.edit)
  }
  return edits
}

