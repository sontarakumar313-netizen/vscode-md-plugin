import { getVditorInternals, getVditorMode } from './vditor-adapter'

interface ClipboardLute {
  VditorDOM2HTML(value: string): string
  VditorDOM2Md(value: string): string
}

export interface EditorClipboardController {
  dispose(): void
}

function activeEditorRoot(): HTMLElement | null {
  const mode = getVditorMode()
  const internal = getVditorInternals()
  const root = mode ? internal?.[mode]?.element : null
  return root instanceof HTMLElement ? root : null
}

function clipboardLute(): ClipboardLute | null {
  const candidate: unknown = getVditorInternals()?.lute
  if (!candidate || typeof candidate !== 'object') return null
  const lute = candidate as Partial<ClipboardLute>
  return typeof lute.VditorDOM2HTML === 'function' &&
    typeof lute.VditorDOM2Md === 'function'
    ? (lute as ClipboardLute)
    : null
}

function editorRange(root: HTMLElement): Range | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  return root.contains(range.startContainer) && root.contains(range.endContainer)
    ? range
    : null
}

function closestElement(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement
}

function selectionInsideOneCode(range: Range): HTMLElement | null {
  const start = closestElement(range.startContainer)?.closest<HTMLElement>('code')
  const end = closestElement(range.endContainer)?.closest<HTMLElement>('code')
  return start && end && start === end ? start : null
}

function sanitizeCopiedHtml(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  template.content
    .querySelectorAll('script, style, iframe, object, embed')
    .forEach((element) => element.remove())
  template.content.querySelectorAll<HTMLElement>('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || name === 'srcdoc') {
        element.removeAttribute(attribute.name)
        continue
      }
      if (
        (name === 'href' || name === 'src') &&
        /^\s*javascript:/i.test(attribute.value)
      ) {
        element.removeAttribute(attribute.name)
      }
    }
  })
  const container = document.createElement('div')
  container.append(template.content.cloneNode(true))
  return container.innerHTML
}

function selectedClipboardContent(
  range: Range
): { html: string; plain: string } | null {
  const selectedText = range.toString()
  if (!selectedText) return null
  const mode = getVditorMode()
  if (mode === 'sv') return { html: '', plain: selectedText }
  if (mode !== 'wysiwyg') return null

  const code = selectionInsideOneCode(range)
  if (code) {
    const plain = code.parentElement?.tagName === 'PRE'
      ? selectedText
      : `\`${selectedText}\``
    return { html: '', plain }
  }

  const lute = clipboardLute()
  if (!lute) return { html: '', plain: selectedText }
  const fragment = document.createElement('div')
  fragment.append(range.cloneContents())
  try {
    const plain = lute.VditorDOM2Md(fragment.innerHTML).trim()
    const html = sanitizeCopiedHtml(lute.VditorDOM2HTML(fragment.innerHTML))
    return { html, plain: plain || selectedText }
  } catch (error) {
    console.error('[markdown-interactor] failed to serialize selection', error)
    return { html: '', plain: selectedText }
  }
}

function writeClipboard(
  event: ClipboardEvent,
  content: { html: string; plain: string }
): boolean {
  const clipboard = event.clipboardData
  if (!clipboard) return false
  try {
    clipboard.setData('text/plain', content.plain)
    clipboard.setData('text/html', content.html)
    return true
  } catch (error) {
    console.error('[markdown-interactor] failed to write clipboard data', error)
    return false
  }
}

function dispatchInput(
  root: HTMLElement,
  inputType: 'deleteByCut' | 'insertFromPaste',
  data: string | null
): void {
  const event = typeof InputEvent === 'function'
    ? new InputEvent('input', {
        bubbles: true,
        data,
        inputType,
      })
    : new Event('input', { bubbles: true })
  root.dispatchEvent(event)
}

function deleteSelection(root: HTMLElement, range: Range): void {
  let deleted = false
  try {
    deleted = document.execCommand('delete')
  } catch (error) {
    console.warn('[markdown-interactor] native cut deletion failed', error)
  }
  if (deleted && window.getSelection()?.isCollapsed) return

  range.deleteContents()
  range.collapse(true)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  dispatchInput(root, 'deleteByCut', null)
}

function isCodePasteTarget(target: EventTarget | null, root: HTMLElement): boolean {
  const element = target instanceof Element
    ? target
    : target instanceof Node
      ? target.parentElement
      : null
  if (!element || !root.contains(element)) return false
  if (element.closest('code')) return true
  return (
    getVditorMode() === 'sv' &&
    !!element.closest('[data-type="code-block"]')
  )
}

function insertPlainText(root: HTMLElement, text: string): void {
  let inserted = false
  try {
    inserted = document.execCommand('insertText', false, text)
  } catch (error) {
    console.warn('[markdown-interactor] native plain-text paste failed', error)
  }
  if (inserted) return

  const range = editorRange(root)
  if (!range) return
  range.deleteContents()
  const textNode = document.createTextNode(text)
  range.insertNode(textNode)
  range.setStartAfter(textNode)
  range.collapse(true)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  dispatchInput(root, 'insertFromPaste', text)
}

/**
 * Normalizes editor clipboard behavior in the capture phase. Popup inputs are
 * outside the active editor root and therefore retain Chromium's native path.
 */
export function installEditorClipboard(): EditorClipboardController {
  const onCopyOrCut = (event: ClipboardEvent): void => {
    const root = activeEditorRoot()
    if (!root || !(event.target instanceof Node) || !root.contains(event.target)) {
      return
    }
    const range = editorRange(root)
    if (!range || range.collapsed) return
    const content = selectedClipboardContent(range)
    if (!content || !writeClipboard(event, content)) return

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    if (event.type === 'cut') deleteSelection(root, range)
  }

  const onPaste = (event: ClipboardEvent): void => {
    const root = activeEditorRoot()
    const clipboard = event.clipboardData
    if (
      !root ||
      !clipboard ||
      !(event.target instanceof Node) ||
      !root.contains(event.target) ||
      clipboard.files.length > 0
    ) {
      return
    }

    const forcePlainText =
      getVditorMode() === 'sv' || isCodePasteTarget(event.target, root)
    if (!forcePlainText) return
    const text = clipboard.getData('text/plain')
    if (!text && clipboard.types.length > 0) return

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    insertPlainText(root, text)
  }

  document.addEventListener('copy', onCopyOrCut, true)
  document.addEventListener('cut', onCopyOrCut, true)
  document.addEventListener('paste', onPaste, true)

  return {
    dispose(): void {
      document.removeEventListener('copy', onCopyOrCut, true)
      document.removeEventListener('cut', onCopyOrCut, true)
      document.removeEventListener('paste', onPaste, true)
    },
  }
}
