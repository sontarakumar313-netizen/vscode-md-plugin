import {
  commitVditorWysiwygDomEdit,
  focusVditorRange,
  getVditorInternals,
} from './vditor-adapter'
import { closeActiveWysiwygPopover } from './wysiwyg-popover'

const ZERO_WIDTH_SPACE = '\u200b'
const SELECTED_CLASS = 'vmd-code-block--selected'
const BLOCK_EDGE_WIDTH = 18
const BLOCK_GAP_HEIGHT = 32

export type WysiwygAtomicBlockKind =
  | 'code-block'
  | 'math-block'
  | 'html-block'

export type WysiwygAtomicBlockPlacement = 'before' | 'after'

export const WYSIWYG_ATOMIC_BLOCK_SELECTOR = [
  '.vditor-wysiwyg__block[data-type="code-block"]',
  '.vditor-wysiwyg__block[data-type="math-block"]',
  '.vditor-wysiwyg__block[data-type="html-block"]',
].join(', ')

export const WYSIWYG_ATOMIC_INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, details, summary, audio, video, img, iframe, .vditor-copy, .vmd-code-toolbar, [contenteditable="true"]'

export interface WysiwygBlockParts {
  block: HTMLElement
  kind: WysiwygAtomicBlockKind
  source: HTMLElement
  sourceCode: HTMLElement
  preview: HTMLElement
}

let selectedAtomicBlock: HTMLElement | null = null

function closestElement(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement
}

export function wysiwygBlockKind(
  block: HTMLElement | null
): WysiwygAtomicBlockKind | null {
  if (!block) return null
  const type = block.dataset.type
  if (type === 'code-block' || type === 'math-block') return type
  if (
    type === 'html-block' &&
    !block.classList.contains('vmd-details-opener') &&
    !block.classList.contains('vmd-details-closer')
  ) {
    return type
  }
  return null
}

export function isWysiwygAtomicBlock(
  block: HTMLElement | null
): block is HTMLElement {
  return wysiwygBlockKind(block) !== null
}

/** Resolves serializer-owned source and its rendered preview for block syntax. */
export function getWysiwygBlockParts(
  block: HTMLElement
): WysiwygBlockParts | null {
  const type = block.dataset.type
  if (
    type !== 'code-block' &&
    type !== 'math-block' &&
    type !== 'html-block'
  ) {
    return null
  }
  const preview = block.querySelector<HTMLElement>(
    ':scope > .vditor-wysiwyg__preview'
  )
  const source = preview?.previousElementSibling
  if (!(preview instanceof HTMLElement) || !(source instanceof HTMLElement)) {
    return null
  }
  const sourceCode = source.matches('code')
    ? source
    : source.querySelector<HTMLElement>(':scope > code')
  return sourceCode
    ? { block, kind: type, source, sourceCode, preview }
    : null
}

export function atomicBlockAtPoint(event: PointerEvent): HTMLElement | null {
  const range = document.caretRangeFromPoint?.(event.clientX, event.clientY)
  if (!range) return null
  const candidate = closestElement(range.startContainer)?.closest<HTMLElement>(
    WYSIWYG_ATOMIC_BLOCK_SELECTOR
  ) || null
  return isWysiwygAtomicBlock(candidate) ? candidate : null
}

export function isAtomicBlockGap(
  block: HTMLElement,
  target: Element,
  event: PointerEvent
): boolean {
  const interactive = target.closest(WYSIWYG_ATOMIC_INTERACTIVE_SELECTOR)
  if (interactive && block.contains(interactive)) return false
  const preview = getWysiwygBlockParts(block)?.preview
  if (preview?.contains(target)) return false

  const rect = block.getBoundingClientRect()
  return (
    rect.width > 0 &&
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top - BLOCK_GAP_HEIGHT &&
    event.clientY <= rect.bottom + BLOCK_GAP_HEIGHT
  )
}

export function atomicBlockAtRange(range: Range): HTMLElement | null {
  const start = closestElement(range.startContainer)?.closest<HTMLElement>(
    WYSIWYG_ATOMIC_BLOCK_SELECTOR
  ) || null
  const end = closestElement(range.endContainer)?.closest<HTMLElement>(
    WYSIWYG_ATOMIC_BLOCK_SELECTOR
  ) || null
  return start === end && isWysiwygAtomicBlock(start) ? start : null
}

export function rangeContainsNodeContents(
  range: Range,
  node: HTMLElement
): boolean {
  const contents = document.createRange()
  contents.selectNodeContents(node)
  return (
    range.compareBoundaryPoints(Range.START_TO_START, contents) <= 0 &&
    range.compareBoundaryPoints(Range.END_TO_END, contents) >= 0
  )
}

function directRangeBlock(range: Range): HTMLElement | null {
  const element = closestElement(range.startContainer)
  const root = element?.closest<HTMLElement>('.vditor-reset') || null
  const start = element instanceof HTMLElement ? element : element?.parentElement
  if (!start || !root) return null
  let block = start
  while (block.parentElement && block.parentElement !== root) {
    block = block.parentElement
  }
  return block.parentElement === root ? block : null
}

function rangeEdgeIsEmpty(
  range: Range,
  block: HTMLElement,
  edge: WysiwygAtomicBlockPlacement
): boolean {
  const remainder = document.createRange()
  remainder.selectNodeContents(block)
  try {
    if (edge === 'before') {
      remainder.setEnd(range.startContainer, range.startOffset)
    } else {
      remainder.setStart(range.startContainer, range.startOffset)
    }
  } catch (_) {
    return false
  }
  return !remainder.toString().replaceAll(ZERO_WIDTH_SPACE, '').trim()
}

export function atomicBlockBeforeBoundary(range: Range): HTMLElement | null {
  if (!range.collapsed) return null
  if (range.startContainer instanceof Element) {
    const previous = range.startContainer.childNodes[range.startOffset - 1]
    if (previous instanceof HTMLElement && isWysiwygAtomicBlock(previous)) {
      return previous
    }
  }

  const block = directRangeBlock(range)
  if (!block || !rangeEdgeIsEmpty(range, block, 'before')) return null
  const previous = block.previousElementSibling
  return previous instanceof HTMLElement && isWysiwygAtomicBlock(previous)
    ? previous
    : null
}

export function atomicBlockAfterBoundary(range: Range): HTMLElement | null {
  if (!range.collapsed) return null
  if (range.startContainer instanceof Element) {
    const next = range.startContainer.childNodes[range.startOffset]
    if (next instanceof HTMLElement && isWysiwygAtomicBlock(next)) return next
  }

  const block = directRangeBlock(range)
  if (!block || !rangeEdgeIsEmpty(range, block, 'after')) return null
  const next = block.nextElementSibling
  return next instanceof HTMLElement && isWysiwygAtomicBlock(next) ? next : null
}

export function atomicBlockEdgePlacement(
  block: HTMLElement,
  target: Element,
  event: PointerEvent
): WysiwygAtomicBlockPlacement | null {
  const interactive = target.closest(WYSIWYG_ATOMIC_INTERACTIVE_SELECTOR)
  if (interactive && block.contains(interactive)) return null
  const rect = block.getBoundingClientRect()
  if (rect.width <= 0) return null
  const edgeWidth = Math.min(BLOCK_EDGE_WIDTH, rect.width / 4)
  if (event.clientX <= rect.left + edgeWidth) return 'before'
  if (event.clientX >= rect.right - edgeWidth) return 'after'
  return null
}

export function rangeSelectsAtomicBlock(
  range: Range,
  block: HTMLElement
): boolean {
  const parent = block.parentNode
  if (!parent || range.startContainer !== parent || range.endContainer !== parent) {
    return false
  }
  const index = Array.from(parent.childNodes).indexOf(block)
  return range.startOffset === index && range.endOffset === index + 1
}

export function getSelectedAtomicBlock(): HTMLElement | null {
  return selectedAtomicBlock
}

export function clearAtomicBlockSelection(collapseAfter = false): void {
  const block = selectedAtomicBlock
  selectedAtomicBlock = null
  block?.classList.remove(SELECTED_CLASS)
  if (!collapseAfter || !block?.isConnected) return

  const range = document.createRange()
  range.selectNode(block)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

export function selectAtomicBlock(block: HTMLElement): void {
  if (!block.isConnected || !isWysiwygAtomicBlock(block)) return
  if (selectedAtomicBlock !== block) clearAtomicBlockSelection()
  selectedAtomicBlock = block
  block.classList.add(SELECTED_CLASS)
  block.closest<HTMLElement>('.vditor-reset')?.focus({ preventScroll: true })
  const range = document.createRange()
  range.selectNode(block)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

export function activeSelectedAtomicBlock(): HTMLElement | null {
  const block = selectedAtomicBlock
  const selection = window.getSelection()
  if (
    !block?.isConnected ||
    !selection ||
    selection.rangeCount !== 1 ||
    !rangeSelectsAtomicBlock(selection.getRangeAt(0), block)
  ) {
    clearAtomicBlockSelection()
    return null
  }
  return block
}

export function placeCaretNextToAtomicBlock(
  block: HTMLElement,
  placement: WysiwygAtomicBlockPlacement
): void {
  clearAtomicBlockSelection()
  block.closest<HTMLElement>('.vditor-reset')?.focus({ preventScroll: true })
  const range = document.createRange()
  range.selectNode(block)
  range.collapse(placement === 'before')
  focusVditorRange(range)
}

export function insertParagraphByAtomicBlock(
  block: HTMLElement,
  placement: WysiwygAtomicBlockPlacement
): boolean {
  const internal = getVditorInternals()
  if (
    !internal ||
    internal.currentMode !== 'wysiwyg' ||
    !block.isConnected ||
    !block.parentElement ||
    !isWysiwygAtomicBlock(block)
  ) {
    return false
  }

  clearAtomicBlockSelection()
  closeActiveWysiwygPopover()
  const paragraph = document.createElement('p')
  paragraph.dataset.block = '0'
  paragraph.innerHTML = '<br>'
  block.insertAdjacentElement(
    placement === 'before' ? 'beforebegin' : 'afterend',
    paragraph
  )

  const range = document.createRange()
  range.selectNodeContents(paragraph)
  range.collapse(true)
  focusVditorRange(range)
  commitVditorWysiwygDomEdit(internal)
  return true
}

export function sourceOwnedAtomicBlockMarkdown(
  block: HTMLElement
): string | null {
  const parts = getWysiwygBlockParts(block)
  if (!parts) return null

  let value = parts.sourceCode.textContent || ''
  if (value.startsWith(ZERO_WIDTH_SPACE)) value = value.slice(1)
  if (parts.kind === 'html-block') return value
  if (parts.kind !== 'math-block') return null
  if (value.endsWith('\n')) value = value.slice(0, -1)
  const marker = block.dataset.marker || '$$'
  return `${marker}\n${value}\n${marker}`
}
