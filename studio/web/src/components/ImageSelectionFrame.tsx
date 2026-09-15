/**
 * Shared animated frame for selected or active images.
 *
 * The visual is deliberately isolated from selection state and pointer handling:
 * callers keep their existing aria and interaction semantics, while CSS owns the
 * RGB chase animation and reduced-motion fallback.
 */
export default function ImageSelectionFrame() {
  return (
    <span className="ui-image-selection-frame" aria-hidden="true">
      <span className="ui-image-selection-frame-gradient" />
    </span>
  )
}
