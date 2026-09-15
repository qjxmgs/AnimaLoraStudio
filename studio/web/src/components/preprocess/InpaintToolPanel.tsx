import { useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import Button from '../Button'
import { SegmentedControl } from '../SelectionGroup'
import type { InpaintMode, InpaintTool } from './InpaintCanvas'
import {
  INPAINT_TOOL_SHORTCUT_LABELS,
  type InpaintBrushState,
} from './inpaintPreferences'

export default function InpaintToolPanel({
  mode,
  setMode,
  tool,
  setTool,
  brush,
  setBrush,
  recentColors,
  children,
}: {
  mode: InpaintMode
  setMode: (mode: InpaintMode) => void
  tool: InpaintTool
  setTool: (tool: InpaintTool) => void
  brush: InpaintBrushState
  setBrush: Dispatch<SetStateAction<InpaintBrushState>>
  recentColors: string[]
  children?: ReactNode
}) {
  const { t } = useTranslation()
  const [recentOpen, setRecentOpen] = useState(false)

  return (
    <div className="bg-sunken border border-subtle rounded-md flex flex-col h-full min-h-0 overflow-hidden">
      <div className="flex flex-col gap-2 p-2.5 flex-1 min-h-0 overflow-y-auto">
        <h3 className="caption">{t('preprocessInpaint.panelTitle')}</h3>
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-fg-tertiary shrink-0 w-10">{t('preprocessInpaint.modeLabel')}</span>
          <SegmentedControl
            items={(['paint', 'mask'] as const).map((value) => ({
              value,
              label: t(`preprocessInpaint.mode.${value}`),
            }))}
            value={mode}
            onChange={setMode}
            ariaLabel={t('preprocessInpaint.modeLabel')}
            idPrefix="inpaint-mode"
            size="sm"
            layout="content"
          />
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-fg-tertiary shrink-0 w-10">{t('preprocessInpaint.toolLabel')}</span>
          <SegmentedControl
            items={(['brush', 'eraser', 'lasso'] as const).map((value) => {
              const label = t(`preprocessInpaint.tool.${value}`)
              const shortcut = INPAINT_TOOL_SHORTCUT_LABELS[value]
              return {
                value,
                label,
                shortcut,
                title: t('preprocessInpaint.toolShortcut', { tool: label, key: shortcut }),
              }
            })}
            value={tool}
            onChange={setTool}
            ariaLabel={t('preprocessInpaint.toolLabel')}
            idPrefix="inpaint-tool"
            size="sm"
            layout="content"
          />
        </div>

        {mode === 'paint' && (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-fg-tertiary shrink-0 w-10">{t('preprocessInpaint.brushColor')}</span>
            <input
              type="color"
              value={brush.color}
              onChange={(event) => setBrush((prev) => ({ ...prev, color: event.target.value }))}
              className="flex-1 min-w-0 h-7 p-0 border border-subtle rounded cursor-pointer bg-transparent"
              title={t('preprocessInpaint.colorWheel')}
              aria-label={t('preprocessInpaint.colorWheel')}
            />
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setRecentOpen((value) => !value)}
              disabled={recentColors.length === 0}
              aria-expanded={recentOpen}
              aria-controls={recentOpen && recentColors.length > 0 ? 'inpaint-recent-colors' : undefined}
              title={t('preprocessInpaint.recentColors')}
            >
              {t('preprocessInpaint.recentColorsShort')}
            </Button>
          </div>
        )}
        {mode === 'paint' && recentOpen && recentColors.length > 0 && (
          <div
            id="inpaint-recent-colors"
            role="group"
            aria-label={t('preprocessInpaint.recentColors')}
            className="flex items-center gap-1 flex-wrap"
          >
            {recentColors.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => {
                  setBrush((prev) => ({ ...prev, color }))
                  setRecentOpen(false)
                }}
                className={
                  'w-5 h-5 rounded border transition-transform hover:scale-110 ' +
                  (color === brush.color ? 'border-accent' : 'border-dim')
                }
                style={{ backgroundColor: color }}
                title={color}
                aria-label={t('preprocessInpaint.useRecentColor', { color })}
              />
            ))}
          </div>
        )}

        {tool !== 'lasso' && <div className="flex items-center gap-1.5 text-xs">
          <span className="text-fg-tertiary shrink-0 w-10">{t('preprocessInpaint.brushSize')}</span>
          <input
            type="range"
            min={1} max={400} step={1}
            value={brush.size}
            onChange={(event) => setBrush((prev) => ({ ...prev, size: Number(event.target.value) }))}
            className="flex-1 min-w-0"
            aria-label={t('preprocessInpaint.brushSizeSlider')}
          />
          <input
            type="number"
            min={1} max={400}
            value={brush.size}
            onChange={(event) => setBrush((prev) => ({
              ...prev,
              size: Math.max(1, Math.min(400, Number(event.target.value) || 1)),
            }))}
            className="input input-mono text-sm shrink-0"
            style={{ width: 56, padding: '2px 6px' }}
            aria-label={t('preprocessInpaint.brushSizeValue')}
          />
        </div>}
        {tool !== 'lasso' && <div className="flex items-center gap-1.5 text-xs">
          <span className="text-fg-tertiary shrink-0 w-10">{t('preprocessInpaint.brushHardness')}</span>
          <input
            type="range"
            min={0} max={100} step={5}
            value={Math.round(brush.hardness * 100)}
            onChange={(event) => setBrush((prev) => ({
              ...prev,
              hardness: Number(event.target.value) / 100,
            }))}
            className="flex-1 min-w-0"
            aria-label={t('preprocessInpaint.brushHardnessSlider')}
          />
          <input
            type="number"
            min={0} max={100} step={5}
            value={Math.round(brush.hardness * 100)}
            onChange={(event) => setBrush((prev) => ({
              ...prev,
              hardness: Math.max(0, Math.min(100, Number(event.target.value) || 0)) / 100,
            }))}
            className="input input-mono text-sm shrink-0"
            style={{ width: 56, padding: '2px 6px' }}
            aria-label={t('preprocessInpaint.brushHardnessValue')}
          />
        </div>}
        {tool === 'lasso' && (
          <p className="text-[11px] leading-4 text-fg-tertiary">
            {t('preprocessInpaint.lassoPanelHint')}
          </p>
        )}
        {children}
      </div>
    </div>
  )
}

