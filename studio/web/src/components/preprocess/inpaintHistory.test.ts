import { describe, expect, it } from 'vitest'
import type { LassoShape } from './InpaintCanvas'
import {
  resolveMaskEdits,
  resolvePaintEdits,
  type InpaintHistoryEntry,
} from './inpaintHistory'

const shape: LassoShape = {
  id: 'lasso-1',
  color: '#ffffff',
  points: [
    { id: 'p1', x: 10, y: 10, smooth: false },
    { id: 'p2', x: 30, y: 10, smooth: false },
    { id: 'p3', x: 30, y: 30, smooth: false },
  ],
}

describe('inpaint lasso deletion history', () => {
  it('removes a deleted lasso and restores its latest geometry when deletion is undone', () => {
    const updated = {
      ...shape,
      points: shape.points.map((point, index) => index === 0
        ? { ...point, x: 15, smooth: true }
        : point),
    }
    const history: InpaintHistoryEntry[] = [
      { kind: 'paint', edit: { type: 'lasso', shape } },
      { kind: 'lasso-update', target: 'paint', shape: updated },
      { kind: 'lasso-delete', target: 'paint', shapeId: shape.id },
    ]

    expect(resolvePaintEdits(history)).toEqual([])
    expect(resolvePaintEdits(history.slice(0, -1))).toEqual([
      { type: 'lasso', shape: updated },
    ])
    expect(resolvePaintEdits(history)).toEqual([])
  })

  it('isolates deletions by editing mode and preserves unrelated edits', () => {
    const history: InpaintHistoryEntry[] = [
      { kind: 'paint', edit: { type: 'lasso', shape } },
      { kind: 'mask', edit: { type: 'lasso', shape } },
      {
        kind: 'mask',
        edit: {
          type: 'stroke',
          stroke: {
            color: '#ff2d2d', size: 20, hardness: 1,
            points: [{ x: 5, y: 5 }],
          },
        },
      },
      { kind: 'lasso-delete', target: 'mask', shapeId: shape.id },
    ]

    expect(resolvePaintEdits(history)).toEqual([{ type: 'lasso', shape }])
    expect(resolveMaskEdits(history)).toEqual([
      expect.objectContaining({ type: 'stroke' }),
    ])
  })
})
