import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ZoomableImage from './ZoomableImage'

describe('ZoomableImage overlay', () => {
  it('places a non-interactive overlay in the same natural-size transform container', () => {
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <ZoomableImage
          src="/image.png"
          alt="preview"
          overlay={<div data-testid="visual-overlay" />}
        />
      </div>,
    )
    const image = container.querySelector('img[alt="preview"]') as HTMLImageElement
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 640 },
      naturalHeight: { configurable: true, value: 480 },
    })
    fireEvent.load(image)

    const content = container.querySelector('[data-zoomable-image-content]') as HTMLElement
    const overlay = screen.getByTestId('visual-overlay')
    expect(content).toHaveStyle({ width: '640px', height: '480px' })
    expect(content).toContainElement(image)
    expect(content).toContainElement(overlay)
    expect(overlay.parentElement).toHaveClass('absolute', 'inset-0', 'pointer-events-none')
    expect(overlay.parentElement).toHaveAttribute('aria-hidden', 'true')
  })
})
