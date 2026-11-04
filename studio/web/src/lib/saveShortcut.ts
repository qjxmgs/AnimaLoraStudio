import { flushSync } from 'react-dom'

// Pages with a debounced writer can drain it through this event when no dialog is open.
export const SAVE_PAGE_EVENT = 'studio:save-page'
const modalSelector = '[aria-modal="true"]'

function visible(element: HTMLElement) {
  return !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
    (element.checkVisibility?.({ visibilityProperty: true }) ?? true)
}

export function installSaveShortcut() {
  const handle = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey ||
      event.shiftKey || event.key.toLowerCase() !== 's') return
    event.preventDefault()
    if (event.repeat || event.isComposing) return

    const dialogs = Array.from(document.querySelectorAll<HTMLElement>(modalSelector)).filter(visible)
    const scope = dialogs[dialogs.length - 1] ?? document.body
    const findSave = () => Array.from(scope.querySelectorAll<HTMLButtonElement>(
      'button[aria-keyshortcuts~="Control+S"]',
    )).find(button => visible(button) && button.closest(modalSelector) === (scope === document.body ? null : scope))

    // Commit fields that persist on blur before reading the button's latest disabled state.
    const field = document.activeElement
    if (field instanceof HTMLElement && scope.contains(field) && field.matches('input, textarea, [contenteditable="true"]') &&
      (findSave() || field.closest('[data-save-on-blur]'))) {
      flushSync(() => field.blur())
      if (document.activeElement === document.body && field.isConnected) field.focus({ preventScroll: true })
    }
    const save = findSave()
    if (save) save.click()
    else if (scope === document.body) window.dispatchEvent(new Event(SAVE_PAGE_EVENT))
  }
  window.addEventListener('keydown', handle, true)
  return () => window.removeEventListener('keydown', handle, true)
}
