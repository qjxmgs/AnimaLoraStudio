import { useEffect, useRef } from 'react'
import {
  loadTrainingMaskPreview,
  TRAINING_MASK_VIEW_ALPHA,
} from './trainingMaskPreview'

/** Read-only overlay for a persisted training mask. The parent supplies the
 * image-sized positioning context; failed loads remain transparent. */
export default function TrainingMaskOverlay({ src }: { src: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    let cancelled = false
    const canvas = canvasRef.current
    if (canvas) {
      canvas.width = 1
      canvas.height = 1
      canvas.style.visibility = 'hidden'
    }

    void loadTrainingMaskPreview(src).then((preview) => {
      if (cancelled || !preview || !canvasRef.current) return
      const target = canvasRef.current
      target.width = preview.width
      target.height = preview.height
      const context = target.getContext('2d')
      if (!context) return
      context.drawImage(preview, 0, 0)
      target.style.visibility = 'visible'
    })

    return () => { cancelled = true }
  }, [src])

  return (
    <canvas
      ref={canvasRef}
      data-training-mask-overlay
      aria-hidden="true"
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ opacity: TRAINING_MASK_VIEW_ALPHA, visibility: 'hidden' }}
    />
  )
}
