/**
 * Shared animated frame for selected or active images.
 *
 * The visual is deliberately isolated from selection state and pointer handling:
 * callers keep their existing aria and interaction semantics, while CSS owns the
 * RGB chase animation and reduced-motion fallback.
 */
interface Props {
  animated?: boolean
}

export default function ImageSelectionFrame({ animated = true }: Props) {
  return (
    <span
      className={`ui-image-selection-frame${animated ? '' : ' ui-image-selection-frame-static'}`}
      aria-hidden="true"
    >
      <span className="ui-image-selection-frame-gradient" />
    </span>
  )
}
