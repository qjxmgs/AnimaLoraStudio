import { useRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { marqueeHits, useGridMarquee } from './useGridMarquee'

const names = ['a', 'b', 'c', 'd', 'e', 'f']
const geometry = { left: 8, top: 8, width: 100, height: 100, columns: 2, columnGap: 4, rowGap: 4 }
const rect = (left: number, top: number, width: number, height: number) => ({
  left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}),
})

function setup(initial = new Set<string>()) {
  const commit = vi.fn(), activate = vi.fn()
  function Harness() {
    const root = useRef<HTMLDivElement>(null)
    const { scrollerRef, box, preview } = useGridMarquee(root, names, initial, commit)
    return <div ref={root} data-testid="root" onClick={activate}>
      <div ref={(node) => { scrollerRef.current = node }} data-testid="scroll">
        <div className="ui-image-grid-list" style={{ gap: 4, padding: 8 }}>
          <div data-index="2" data-testid="cell"><button>checkbox</button></div>
        </div>
      </div>
      {box && <div data-testid="box" />}
      <output>{[...(preview ?? initial)].join(',')}</output>
    </div>
  }
  render(<Harness />)
  const root = screen.getByTestId('root'), scroll = screen.getByTestId('scroll'), cell = screen.getByTestId('cell')
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 220, 220))
  vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 220, 220))
  // Only row 2 is mounted: hit testing must still cover the first/last rows.
  vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(rect(8, 112, 100, 100))
  Object.defineProperties(scroll, { clientWidth: { value: 220 }, clientHeight: { value: 220 } })
  Object.defineProperty(cell.parentElement, 'clientWidth', { value: 220 })
  return { root, cell, scroll, commit, activate }
}

describe('image grid marquee', () => {
  it('hits virtual rows in either drag direction and excludes grid gaps', () => {
    expect(marqueeHits(names, geometry, { x: 110, y: 1 }, { x: 111, y: 219 }).size).toBe(0)
    expect(marqueeHits(names, geometry, { x: 211, y: 315 }, { x: 9, y: 9 })).toEqual(new Set(names))
  })

  it('previews a rectangle and commits once, suppressing the resulting click', () => {
    const { root, commit, activate } = setup(new Set(['f']))
    fireEvent.mouseDown(root, { button: 0, clientX: 1, clientY: 1 })
    fireEvent.mouseMove(window, { buttons: 1, clientX: 210, clientY: 100 })
    expect(screen.getByTestId('box')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('a,b')
    expect(commit).not.toHaveBeenCalled()
    fireEvent.mouseUp(window, { button: 0 })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(new Set(['a', 'b']))
    fireEvent.click(root)
    expect(activate).not.toHaveBeenCalled()
    expect(screen.queryByTestId('box')).not.toBeInTheDocument()
  })

  it.each(['ctrlKey', 'shiftKey', 'metaKey'])('adds to the selection with %s and retracts transient hits', (modifier) => {
    const { root, commit } = setup(new Set(['f']))
    fireEvent.mouseDown(root, { button: 0, clientX: 1, clientY: 1, [modifier]: true })
    fireEvent.mouseMove(window, { buttons: 1, clientX: 210, clientY: 200 })
    fireEvent.mouseMove(window, { buttons: 1, clientX: 100, clientY: 100 })
    fireEvent.mouseUp(window, { button: 0 })
    expect(commit).toHaveBeenCalledWith(new Set(['f', 'a']))
  })

  it('keeps ordinary clicks and checkbox interactions intact', () => {
    const { root, commit, activate } = setup()
    fireEvent.mouseDown(root, { button: 0, clientX: 20, clientY: 20 })
    fireEvent.mouseMove(window, { buttons: 1, clientX: 22, clientY: 21 })
    fireEvent.mouseUp(window, { button: 0 })
    fireEvent.click(root)
    expect(activate).toHaveBeenCalledTimes(1)
    fireEvent.mouseDown(screen.getByRole('button'), { button: 0, clientX: 20, clientY: 120 })
    fireEvent.mouseMove(window, { buttons: 1, clientX: 210, clientY: 200 })
    fireEvent.mouseUp(window, { button: 0 })
    expect(commit).not.toHaveBeenCalled()
  })

  it('scrolls at the edge and includes newly reached virtual rows', () => {
    let tick: FrameRequestCallback | undefined
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      tick = callback
      return 1
    })
    try {
      const { root, scroll, commit } = setup()
      fireEvent.mouseDown(root, { button: 0, clientX: 1, clientY: 1 })
      fireEvent.mouseMove(window, { buttons: 1, clientX: 210, clientY: 210 })
      act(() => tick?.(16))
      expect(scroll.scrollTop).toBe(12)
      fireEvent.mouseUp(window, { button: 0 })
      expect(commit).toHaveBeenCalledWith(new Set(names))
    } finally { raf.mockRestore() }
  })

  it.each(['Escape', 'blur'])('cancels the preview on %s', (reason) => {
    const { root, commit } = setup()
    fireEvent.mouseDown(root, { button: 0, clientX: 1, clientY: 1 })
    fireEvent.mouseMove(window, { buttons: 1, clientX: 210, clientY: 100 })
    if (reason === 'Escape') fireEvent.keyDown(window, { key: 'Escape' })
    else fireEvent.blur(window)
    fireEvent.mouseUp(window, { button: 0 })
    expect(commit).not.toHaveBeenCalled()
    expect(screen.queryByTestId('box')).not.toBeInTheDocument()
  })
})
