import { getVditorMode } from './vditor-adapter'
import type { VditorMode } from './vditor-adapter'

const SELECTORS_BY_MODE: Record<VditorMode, string[]> = {
  wysiwyg: ['.vditor-wysiwyg .vditor-reset', '.vditor-wysiwyg'],
  sv: ['.vditor-sv.vditor-reset', '.vditor-sv'],
}

/**
 * The element that actually scrolls in the given mode.
 *
 * Which node overflows isn't fixed (it depends on toolbar pin state and
 * layout), so pick whichever visible candidate is really overflowing instead of
 * hardcoding one selector.
 */
export function getScrollElement(
  mode: VditorMode | null = getVditorMode()
): HTMLElement | null {
  const candidates = [
    ...((mode && SELECTORS_BY_MODE[mode]) || []),
    '.vditor-content',
  ]
    .map((selector) => document.querySelector<HTMLElement>(selector))
    .filter(
      (element): element is HTMLElement =>
        !!element && element.getClientRects().length > 0
    )
  return (
    candidates.find((element) => element.scrollHeight - element.clientHeight > 10) ||
    candidates[0] ||
    null
  )
}

/** Scrolls the collapsed selection into view without moving the caret. */
export function scrollSelectionIntoView(): boolean {
  const selection = window.getSelection()
  if (!selection?.rangeCount) return false
  const scrollElement = getScrollElement()
  if (!scrollElement) return false

  const range = selection.getRangeAt(0).cloneRange()
  range.collapse(true)
  // A collapsed range between elements has no client rect of its own, so
  // measure a temporary zero-size element placed at the caret instead.
  let rect = range.getClientRects().item(0)
  let probe: HTMLElement | null = null
  if (!rect || rect.height === 0) {
    probe = document.createElement('span')
    probe.textContent = '​'
    try {
      range.insertNode(probe)
      rect = probe.getBoundingClientRect()
    } catch (_) {
      probe.remove()
      probe = null
    }
  }

  const viewport = scrollElement.getBoundingClientRect()
  if (rect && rect.height >= 0) {
    const offset = rect.top - viewport.top
    if (offset < 0 || offset > viewport.height - rect.height) {
      scrollElement.scrollTop += offset - viewport.height / 2
    }
  }
  probe?.remove()
  return !!rect
}
