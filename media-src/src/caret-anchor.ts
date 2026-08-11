import {
  getVditorEditorElement,
  getVditorInternals,
  getVditorMode,
} from './vditor-adapter'

export interface EditorSelectionContext {
  root: HTMLElement
  range: Range
  mode: string
}

export interface CaretAnchor {
  text: string
  occurrence: number
  expectedStart: number
}

const toolbarSelections = new WeakMap<object, EditorSelectionContext>()

/** Saves the live editor range before a toolbar pointer event moves focus. */
export function preserveEditorSelectionForToolbar(
  editor: any = window.vditor
): boolean {
  const internal = getVditorInternals(editor)
  const mode = getVditorMode(editor)
  const root = getVditorEditorElement(editor)
  const selection = window.getSelection()
  if (!internal || !mode || !root || !selection?.rangeCount) return false

  const range = selection.getRangeAt(0)
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  ) {
    return false
  }

  const savedRange = range.cloneRange()
  toolbarSelections.set(editor, { root, range: savedRange, mode })
  internal[mode].range = savedRange.cloneRange()
  return true
}

export function getEditorSelectionContext(
  editor: any = window.vditor
): EditorSelectionContext | null {
  const internal = getVditorInternals(editor)
  const mode = getVditorMode(editor)
  const root = getVditorEditorElement(editor)
  if (!internal || !mode || !root) return null

  const selection = window.getSelection()
  const liveRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  const toolbarSelection = toolbarSelections.get(editor)
  const savedRange = internal?.[mode]?.range as Range | undefined

  // Focusing a toolbar button can move the browser selection outside the
  // contenteditable before its click handler runs. Vditor saves the last
  // editor range on blur specifically for this case, so prefer the live range
  // only while it still belongs to the active editor and otherwise fall back
  // to that saved range.
  for (const range of [
    liveRange,
    toolbarSelection?.mode === mode && toolbarSelection.root === root
      ? toolbarSelection.range
      : null,
    savedRange,
  ]) {
    if (
      range &&
      root.contains(range.startContainer) &&
      root.contains(range.endContainer)
    ) {
      return { root, range, mode }
    }
  }
  return null
}

export function countTextOccurrences(source: string, query: string): number {
  if (!query) return 0
  let count = 0
  let offset = 0
  while ((offset = source.indexOf(query, offset)) >= 0) {
    count += 1
    offset += query.length
  }
  return count
}

export function findTextOccurrence(
  source: string,
  query: string,
  occurrence: number
): number {
  if (!query || occurrence < 0) return -1
  let offset = 0
  for (let index = 0; index <= occurrence; index += 1) {
    offset = source.indexOf(query, offset)
    if (offset < 0) return -1
    if (index < occurrence) offset += query.length
  }
  return offset
}

export function getVisibleTextBefore(
  context: EditorSelectionContext | null
): string {
  if (!context) return ''
  const before = document.createRange()
  before.selectNodeContents(context.root)
  before.setEnd(context.range.startContainer, context.range.startOffset)
  return before.toString().replace(/\u00a0/g, ' ')
}

export function getVisibleTextBeforeElement(
  context: EditorSelectionContext | null,
  element: Element
): string {
  if (!context || !context.root.contains(element)) return ''
  const before = document.createRange()
  before.selectNodeContents(context.root)
  before.setEndBefore(element)
  return before.toString().replace(/\u00a0/g, ' ')
}

function getVisibleText(root: HTMLElement): string {
  const range = document.createRange()
  range.selectNodeContents(root)
  return range.toString().replace(/\u00a0/g, ' ')
}

/** Captures a bounded rendered-text anchor ending at a collapsed caret. */
export function captureCaretAnchor(
  editor: any = window.vditor,
  maximumContextLength = 60
): CaretAnchor | null {
  const context = getEditorSelectionContext(editor)
  if (!context || !context.range.collapsed) return null

  const visibleBefore = getVisibleTextBefore(context)
  const text = visibleBefore.slice(-Math.max(1, maximumContextLength))
  const expectedStart = visibleBefore.length - text.length
  return {
    text,
    occurrence: text
      ? findOverlappingOccurrenceIndex(visibleBefore, text, expectedStart)
      : 0,
    expectedStart,
  }
}

function findOverlappingOccurrenceIndex(
  source: string,
  query: string,
  expectedStart: number
): number {
  let occurrence = 0
  let offset = 0
  while ((offset = source.indexOf(query, offset)) >= 0) {
    if (offset === expectedStart) return occurrence
    if (offset > expectedStart) break
    occurrence += 1
    offset += 1
  }
  return 0
}

function findOverlappingOccurrence(
  source: string,
  query: string,
  occurrence: number
): number {
  let offset = 0
  for (let index = 0; index <= occurrence; index += 1) {
    offset = source.indexOf(query, offset)
    if (offset < 0) return -1
    if (index < occurrence) offset += 1
  }
  return offset
}

function findNearestOccurrence(
  source: string,
  query: string,
  expectedStart: number
): number {
  let best = -1
  let bestDistance = Number.POSITIVE_INFINITY
  let offset = 0
  while ((offset = source.indexOf(query, offset)) >= 0) {
    const distance = Math.abs(offset - expectedStart)
    if (distance < bestDistance) {
      best = offset
      bestDistance = distance
    }
    offset += 1
  }
  return best
}

function resolveCaretOffset(root: HTMLElement, anchor: CaretAnchor): number {
  if (!anchor.text) return 0
  const source = getVisibleText(root)
  const occurrence = findOverlappingOccurrence(
    source,
    anchor.text,
    anchor.occurrence
  )
  const start =
    occurrence >= 0
      ? occurrence
      : findNearestOccurrence(source, anchor.text, anchor.expectedStart)
  return start < 0 ? -1 : start + anchor.text.length
}

function resolveTextPosition(
  root: HTMLElement,
  offset: number
): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let remaining = offset
  let lastText: Text | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    lastText = text
    if (remaining <= text.data.length) {
      return { node: text, offset: remaining }
    }
    remaining -= text.data.length
  }
  if (lastText && remaining === 0) {
    return { node: lastText, offset: lastText.data.length }
  }
  if (offset === 0) return { node: root, offset: 0 }
  return null
}

/** Restores a collapsed caret into Vditor's newly rebuilt active editor DOM. */
export function restoreCaretAnchor(
  anchor: CaretAnchor | null,
  editor: any = window.vditor
): boolean {
  if (!anchor) return false
  const root = getVditorEditorElement(editor)
  const internal = getVditorInternals(editor)
  const mode = getVditorMode(editor)
  if (!root || !internal || !mode) return false

  const caretOffset = resolveCaretOffset(root, anchor)
  if (caretOffset < 0) return false
  const position = resolveTextPosition(root, caretOffset)
  if (!position) return false

  try {
    root.focus({ preventScroll: true })
  } catch (_) {
    root.focus()
  }

  const selection = window.getSelection()
  if (!selection) return false
  selection.setBaseAndExtent(
    position.node,
    position.offset,
    position.node,
    position.offset
  )
  if (selection.rangeCount === 0) return false
  internal[mode].range = selection.getRangeAt(0).cloneRange()
  return true
}
