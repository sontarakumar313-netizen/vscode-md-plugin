import {
  getVditorEditorElement,
  getVditorMode,
} from './vditor-adapter'
import {
  getEditorSelectionContext,
  getVisibleTextBefore,
  getVisibleTextBeforeElement,
} from './caret-anchor'
import type { EditorSelectionContext } from './caret-anchor'

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
 * Find the contiguous blockquote block in `source` that contains `offset`.
 * Returns null when the line at `offset` does not start with '>'.
 */
function findQuoteBlockAt(
  source: string,
  offset: number
): { lineStart: number; lineEnd: number } | null {
  const safeOff = Math.min(Math.max(0, offset), source.length)
  const lineStart = source.lastIndexOf('\n', safeOff - 1) + 1
  const lineNl = source.indexOf('\n', lineStart)
  const lineEnd = lineNl >= 0 ? lineNl : source.length
  if (!source.slice(lineStart, lineEnd).startsWith('>')) return null

  // Walk backward to find the first '>' line.
  let blockStart = lineStart
  while (blockStart > 0) {
    const prevNl = blockStart - 1
    const prevLineStart = source.lastIndexOf('\n', prevNl - 1) + 1
    if (!source.slice(prevLineStart, prevNl).startsWith('>')) break
    blockStart = prevLineStart
  }

  // Walk forward to find the last '>' line.
  let pos = blockStart
  while (pos < source.length) {
    const nl = source.indexOf('\n', pos)
    const end = nl >= 0 ? nl : source.length
    if (!source.slice(pos, end).startsWith('>')) break
    pos = nl >= 0 ? nl + 1 : source.length
  }

  return { lineStart: blockStart, lineEnd: pos }
}

function applyBlockquoteIndent(
  source: string,
  block: { lineStart: number; lineEnd: number },
  isShift: boolean
): string {
  const raw = source.slice(block.lineStart, block.lineEnd)
  const trailingNl = raw.endsWith('\n')
  const lines = (trailingNl ? raw.slice(0, -1) : raw).split('\n')

  let changed: string[]
  if (isShift) {
    // Outdent: remove one '> ' level. Stop if any line has no '>' prefix.
    if (!lines.every((l) => l.startsWith('>'))) return source
    changed = lines.map((l) => (l.startsWith('> ') ? l.slice(2) : l.slice(1)))
  } else {
    // Indent: add one '> ' level.
    changed = lines.map((l) => `> ${l}`)
  }

  return (
    source.slice(0, block.lineStart) +
    changed.join('\n') +
    (trailingNl ? '\n' : '') +
    source.slice(block.lineEnd)
  )
}

/**
 * Handle Tab / Shift+Tab when the caret is inside a blockquote.
 * Returns true when it consumed the event, false when it did nothing.
 */
function handleBlockquoteTab(vditor: any, event: KeyboardEvent): boolean {
  const editor = getVditorEditorElement(vditor)
  const target = event.target
  if (!editor || !(target instanceof Node) || !editor.contains(target)) return false

  const range = getEditorRange(editor)
  if (!range) return false

  const mode = getVditorMode(vditor)
  const source = String(vditor?.getValue?.() || '')
  const context: EditorSelectionContext | null = getEditorSelectionContext(vditor)
  if (!context) return false

  let block: { lineStart: number; lineEnd: number } | null = null

  if (mode === 'sv') {
    const visibleBefore = getVisibleTextBefore(context)
    if (!source.startsWith(visibleBefore)) return false
    block = findQuoteBlockAt(source, visibleBefore.length)
  } else if (mode === 'wysiwyg') {
    // Start from the innermost blockquote, then walk up to the outermost so that
    // getVisibleTextBeforeElement measures the gap before the whole block.
    let bqEl = closestInEditor(range.startContainer, 'blockquote', editor)
    if (!bqEl) return false
    let parent: HTMLElement | null = bqEl.parentElement
    while (parent && parent !== editor) {
      if (parent.matches('blockquote')) bqEl = parent
      parent = parent.parentElement
    }
    const blockquoteEl: HTMLElement = bqEl

    // Use the alert marker as a unique anchor when available.
    const domType = blockquoteEl.getAttribute('data-vmd-alert')
    if (domType) {
      const marker = `> [!${domType}]`
      let pos = 0
      while (pos < source.length) {
        const idx = source.indexOf(marker, pos)
        if (idx < 0) break
        if (idx === 0 || source[idx - 1] === '\n') {
          block = findQuoteBlockAt(source, idx)
          break
        }
        pos = idx + 1
      }
    }

    if (!block) {
      // getVisibleTextBeforeElement via Range.toString() returns rendered text
      // without markdown syntax markers. The rendered text may have fewer
      // newlines than the source (paragraph separators collapse to \n).
      // Try matching at the exact offset, then scan forward up to 4 chars
      // (enough to skip a blank line) to find the first '>' line.
      const before = getVisibleTextBeforeElement(context, blockquoteEl)
      if (source.startsWith(before)) {
        let off = before.length
        // Skip any newlines that the renderer collapsed to reach the '>' line.
        while (off < source.length && source[off] === '\n') off++
        block = findQuoteBlockAt(source, off)
      }
    }
  }

  if (!block) return false

  const newSource = applyBlockquoteIndent(source, block, event.shiftKey)
  if (newSource === source) return false

  vditor.setValue(newSource)
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

  return !!closestInEditor(range.startContainer, 'li, td, th', editor)
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
  if ((window as any).__vmdStructuredTabPolicy) return

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
  ;(window as any).__vmdStructuredTabPolicy = {
    tabMovesFocus: () => tabMovesFocus,
    dispose() {
      document.removeEventListener('keydown', onKeydown, true)
      delete (window as any).__vmdStructuredTabPolicy
    },
  }
}
