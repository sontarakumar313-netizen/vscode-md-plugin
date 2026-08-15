import {
  getVditorEditorElement,
  getVditorMode,
  setVditorMarkdown,
} from './vditor-adapter'
import { getEditorSelectionContext } from './caret-anchor'
import {
  captureEditorLineAnchor,
  createSourceViewAnchor,
  resolveCaretLine,
  restoreEditorLineAnchor,
  restoreSourceViewAnchor,
} from './quote-caret'
import { adjustPlainQuoteDepthAt } from './quote-format'

function asElement(node: Node): HTMLElement | null {
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as HTMLElement)
    : node.parentElement
}

function closestInEditor(
  node: Node,
  selector: string,
  editor: HTMLElement
): HTMLElement | null {
  let element = asElement(node)
  while (element && element !== editor) {
    if (element.matches(selector)) return element
    element = element.parentElement
  }
  return null
}

function getEditorRange(editor: HTMLElement): Range | null {
  const selection = window.getSelection()
  if (!selection?.rangeCount) return null

  const range = selection.getRangeAt(0)
  const contains = (node: Node) => node === editor || editor.contains(node)
  return contains(range.startContainer) && contains(range.endContainer)
    ? range
    : null
}

function isSourceListMarker(element: Element | null): boolean {
  const type = element?.getAttribute('data-type')
  return type === 'li-marker' || type === 'task-marker'
}

// ── Blockquote Tab indent / outdent ──────────────────────────────────────────

/**
 * Adds or removes one marker on the caret line of a plain quote. GitHub Alerts
 * and a single remaining quote marker deliberately fall through as no-ops.
 */
function handleBlockquoteTab(vditor: any, event: KeyboardEvent): boolean {
  const editor = getVditorEditorElement(vditor)
  const target = event.target
  if (!editor || !(target instanceof Node) || !editor.contains(target)) return false

  const context = getEditorSelectionContext(vditor)
  if (!context) return false
  const source = String(vditor?.getValue?.() || '')
  const caret = resolveCaretLine(source, context)
  if (!caret?.quoteBlock) return false

  const change = adjustPlainQuoteDepthAt(
    source,
    caret.line.start,
    event.shiftKey
  )
  if (!change) return false

  const anchor = captureEditorLineAnchor(context)
  const sourceViewAnchor = createSourceViewAnchor(
    change.content,
    change.targetText,
    change.targetSourceOffset,
    caret.renderedOffset
  )
  setVditorMarkdown(vditor, change.content)
  if (context.mode === 'sv') {
    restoreSourceViewAnchor(vditor, sourceViewAnchor)
  } else if (anchor) {
    restoreEditorLineAnchor(vditor, {
      ...anchor,
      text: change.targetText,
      offset: Math.min(caret.renderedOffset, change.targetText.length),
    })
  }
  ;(window as any).__vmdCommitProgrammaticEdit?.()
  return true
}

function rangeStartsAtEndOf(range: Range, element: HTMLElement): boolean {
  if (range.startContainer !== element && !element.contains(range.startContainer)) {
    return false
  }

  const contentBeforeCaret = document.createRange()
  contentBeforeCaret.selectNodeContents(element)
  contentBeforeCaret.setEnd(range.startContainer, range.startOffset)
  return contentBeforeCaret.toString() === element.textContent
}

function canHandleSourceListTab(range: Range, editor: HTMLElement): boolean {
  const marker = closestInEditor(
    range.startContainer,
    '[data-type="li-marker"], [data-type="task-marker"]',
    editor
  )
  if (marker && rangeStartsAtEndOf(range, marker)) return true

  const text = closestInEditor(
    range.startContainer,
    '[data-type="text"]',
    editor
  )
  return !!(
    text &&
    range.startOffset === 0 &&
    isSourceListMarker(text.previousElementSibling)
  )
}

function allowsTabInEditor(vditor: any, event: KeyboardEvent): boolean | null {
  const editor = getVditorEditorElement(vditor)
  const target = event.target
  if (!editor || !(target instanceof Node) || !editor.contains(target)) {
    return null
  }

  const range = getEditorRange(editor)
  if (!range) return false

  if (getVditorMode(vditor) === 'sv') {
    // SV contains source text rather than interactive table cells. Only permit
    // Vditor's marker-specific indentation paths; all other positions stay put.
    return canHandleSourceListTab(range, editor)
  }

  return !!closestInEditor(
    range.startContainer,
    'li, td, th, .vmd-code-block--ordinary > .vditor-wysiwyg__preview > code',
    editor
  )
}

/**
 * Tab must not move focus out of the editor. Lists and rendered table cells
 * retain Vditor's native semantics; every other editing location is a no-op.
 *
 * Suppressing Tab makes the editor a keyboard trap under WCAG 2.1.2, so Ctrl+M
 * (Cmd+M) toggles the suppression off and lets Tab move focus normally. That is
 * the same binding VS Code uses for its own "Toggle Tab Key Moves Focus", so the
 * escape hatch is where a keyboard user in this host already expects it. Escape
 * is deliberately not used: Vditor consumes it for hint dismissal and its `esc`
 * option callback.
 */
export function installStructuredTabPolicy(): void {
  let tabMovesFocus = false

  const onKeydown = (event: KeyboardEvent) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === 'm'
    ) {
      tabMovesFocus = !tabMovesFocus
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }

    if (
      event.key !== 'Tab' ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    ) {
      return
    }

    // While the toggle is on, leave Tab entirely alone so the browser's own
    // sequential focus navigation can carry the user out of the editor.
    if (tabMovesFocus) return

    // Blockquote indent/outdent takes priority over the generic Tab policy.
    if (handleBlockquoteTab((window as any).vditor, event)) {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }

    const allowed = allowsTabInEditor((window as any).vditor, event)
    if (allowed !== false) return

    event.preventDefault()
    event.stopImmediatePropagation()
  }

  document.addEventListener('keydown', onKeydown, true)
}
