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
