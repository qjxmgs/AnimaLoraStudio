import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installSaveShortcut, SAVE_PAGE_EVENT } from './saveShortcut'

describe('application save shortcut', () => {
  let clean: () => void
  beforeEach(() => { clean = installSaveShortcut() })
  afterEach(() => { clean(); document.body.replaceChildren() })

  it('saves only in the front dialog and never falls through a disabled or missing action', () => {
    document.body.innerHTML = `
      <button aria-keyshortcuts="Control+S">page</button>
      <div role="dialog" aria-modal="true"><button aria-keyshortcuts="Control+S">dialog</button></div>
      <div role="alertdialog" aria-modal="true"></div>`
    const [page, dialog] = document.querySelectorAll('button')
    const pageSave = vi.fn()
    const dialogSave = vi.fn()
    page.onclick = pageSave
    dialog.onclick = dialogSave
    const save = () => fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    expect(save()).toBe(false)
    document.querySelector('[role=alertdialog]')?.remove()
    dialog.disabled = true
    save()
    expect(dialogSave).not.toHaveBeenCalled()
    expect(pageSave).not.toHaveBeenCalled()
    dialog.disabled = false
    save()
    expect(dialogSave).toHaveBeenCalledTimes(1)
    document.querySelector('[role=dialog]')?.remove()
    save()
    expect(pageSave).toHaveBeenCalledTimes(1)
  })

  it('commits an active autosave field, keeps focus, and drains the page once', () => {
    document.body.innerHTML = '<div data-save-on-blur><input></div>'
    const input = document.querySelector('input')!
    const commit = vi.fn()
    input.onblur = commit
    input.focus()
    const drain = vi.fn()
    window.addEventListener(SAVE_PAGE_EVENT, drain)
    try {
      fireEvent.keyDown(input, { key: 's', metaKey: true })
      fireEvent.keyDown(input, { key: 's', metaKey: true, repeat: true })
      expect(fireEvent.keyDown(input, { key: 'S', ctrlKey: true, shiftKey: true })).toBe(true)
      expect(commit).toHaveBeenCalledTimes(1)
      expect(drain).toHaveBeenCalledTimes(1)
      expect(input).toHaveFocus()
    } finally {
      window.removeEventListener(SAVE_PAGE_EVENT, drain)
    }
  })
})
