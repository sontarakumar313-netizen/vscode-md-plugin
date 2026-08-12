import {
  frontMatterSeparator,
  parseFrontMatter,
  restoreFrontMatterSeparator,
} from './front-matter'
import type { FrontMatterEntry, FrontMatterValue } from './front-matter'

/**
 * Shows YAML front matter as a table in WYSIWYG mode, and hands the raw source
 * back the moment the caret enters the block so it can be edited as a code area.
 *
 * The table lives inside a `.vditor-wysiwyg__preview` container, which Lute skips
 * when it serializes the DOM back to Markdown. That is the whole reason the
 * rendered table cannot leak into the document: the source `<pre><code>` stays
 * exactly where Vditor put it, untouched, and remains the only thing that round
 * trips. Nothing here ever writes a value back.
 *
 * Vditor's own preview/source toggle does not cover this block. Its check is
 * `data-type.indexOf("block") > -1`, and `yaml-front-matter` has no "block" in it,
 * so the focus behaviour below is the plugin's own.
 */

export type FrontMatterDisplay = 'table' | 'codeBlock' | 'hide'

interface ValueApi {
  getValue(): string
  setValue(markdown: string, clearStack?: boolean): void
}

/**
 * Remembers the blank line between the front matter and the document body across
 * a Lute round trip, which would otherwise silently delete it. The public value
 * boundary keeps the separator repair independent from Vditor's rendered DOM.
 */
export function attachFrontMatterSeparator(
  editor: ValueApi,
  /**
   * The document text as the host sent it. Required, because by the time this
   * runs the editor has already been constructed and its own value has had the
   * separator collapsed out of it: capturing from `getValue()` would remember
   * the damaged form and lose the blank line on the first edit.
   */
  source: string
): void {
  const getValue = editor.getValue.bind(editor)
  const setValue = editor.setValue.bind(editor)
  let separator = frontMatterSeparator(source)

  editor.getValue = () => restoreFrontMatterSeparator(getValue(), separator)
  editor.setValue = (markdown: string, clearStack?: boolean) => {
    separator = frontMatterSeparator(markdown)
    setValue(markdown, clearStack)
  }
}

const BLOCK_SELECTOR =
  '.vditor-wysiwyg__block[data-type="yaml-front-matter"]'
const PREVIEW_CLASS = 'vditor-wysiwyg__preview'
const TABLE_CLASS = 'vmd-front-matter'

function getWysiwygRoot(): HTMLElement | null {
  return document.querySelector('.vditor-wysiwyg .vditor-reset')
}

/** The `<pre><code>` Vditor rendered, i.e. the editable source. */
function getSourcePre(block: HTMLElement): HTMLElement | null {
  return block.querySelector<HTMLElement>(
    `:scope > pre:not(.${PREVIEW_CLASS})`
  )
}

function getSourceText(block: HTMLElement): string {
  return getSourcePre(block)?.querySelector('code')?.textContent ?? ''
}

function getPreview(block: HTMLElement): HTMLElement | null {
  return block.querySelector<HTMLElement>(`:scope > .${PREVIEW_CLASS}`)
}

function isFrontMatterBlock(element: HTMLElement, root: HTMLElement): boolean {
  // Front matter is only front matter at the very top of the document. A stray
  // block elsewhere (Vditor can produce one while text is being typed) is left
  // alone rather than rendered as a table in the middle of the body.
  return element.matches(BLOCK_SELECTOR) && element === root.firstElementChild
}

function findBlock(root: HTMLElement): HTMLElement | null {
  const first = root.firstElementChild as HTMLElement | null
  return first && first.matches(BLOCK_SELECTOR) ? first : null
}

function scalarLabel(value: Extract<FrontMatterValue, { kind: 'scalar' }>): string {
  if (value.type === 'null' && value.text === '') return ''
  return value.text
}

/** Flattens a value into rows, indenting nested keys with a path prefix. */
function appendRows(
  body: HTMLElement,
  entries: FrontMatterEntry[],
  depth: number
): void {
  for (const entry of entries) {
    const row = document.createElement('tr')
    const keyCell = document.createElement('td')
    keyCell.className = 'vmd-front-matter__key'
    if (depth > 0) {
      keyCell.classList.add(`vmd-front-matter__key--depth-${Math.min(depth, 3)}`)
    }
    keyCell.textContent = entry.key
    row.appendChild(keyCell)

    const valueCell = document.createElement('td')
    valueCell.className = 'vmd-front-matter__value'
    const value = entry.value

    if (value.kind === 'scalar') {
      valueCell.textContent = scalarLabel(value)
      valueCell.classList.add(`vmd-front-matter__value--${value.type}`)
      row.appendChild(valueCell)
      body.appendChild(row)
      continue
    }

    if (value.kind === 'list' && value.items.every((item) => item.kind === 'scalar')) {
      // A flat list reads better on one line than as one row per element.
      const list = document.createElement('ul')
      list.className = 'vmd-front-matter__list'
      for (const item of value.items) {
        const listItem = document.createElement('li')
        listItem.textContent = scalarLabel(
          item as Extract<FrontMatterValue, { kind: 'scalar' }>
        )
        list.appendChild(listItem)
      }
      valueCell.appendChild(list)
      row.appendChild(valueCell)
      body.appendChild(row)
      continue
    }

    valueCell.classList.add('vmd-front-matter__value--nested')
    row.appendChild(valueCell)
    body.appendChild(row)

    if (value.kind === 'map') {
      appendRows(body, value.entries, depth + 1)
      continue
    }

    value.items.forEach((item, index) => {
      if (item.kind === 'map') {
        appendRows(
          body,
          [{ key: `[${index}]`, value: { kind: 'map', entries: [] } }],
          depth + 1
        )
        appendRows(body, item.entries, depth + 2)
        return
      }
      appendRows(body, [{ key: `[${index}]`, value: item }], depth + 1)
    })
  }
}

function buildTable(source: string): HTMLElement {
  const { entries, error } = parseFrontMatter(source)

  if (error) {
    // test07: invalid YAML must say so clearly and keep the source visible,
    // never silently show an empty or half-filled table.
    const notice = document.createElement('div')
    notice.className = `${TABLE_CLASS} ${TABLE_CLASS}--error`
    const heading = document.createElement('div')
    heading.className = 'vmd-front-matter__error'
    heading.textContent = `Front Matter 解析失败：${error}`
    const raw = document.createElement('pre')
    raw.className = 'vmd-front-matter__raw'
    raw.textContent = source
    notice.appendChild(heading)
    notice.appendChild(raw)
    return notice
  }

  if (entries.length === 0) {
    const empty = document.createElement('div')
    empty.className = `${TABLE_CLASS} ${TABLE_CLASS}--empty`
    empty.textContent = 'Front Matter（空）'
    return empty
  }

  const table = document.createElement('table')
  table.className = TABLE_CLASS
  const caption = document.createElement('caption')
  caption.textContent = 'Front Matter'
  table.appendChild(caption)
  const body = document.createElement('tbody')
  appendRows(body, entries, 0)
  table.appendChild(body)
  return table
}

export function initWysiwygFrontMatter(display: FrontMatterDisplay = 'table') {
  let mode: FrontMatterDisplay = display
  let root: HTMLElement | null = null
  let boundRoot: HTMLElement | null = null
  let observer: MutationObserver | null = null
  let refreshQueued = false
  // Set while the observer's own DOM writes are in flight, so inserting the
  // preview container does not re-enter refresh in an endless loop.
  let writing = false
  let editing = false

  function caretIsInside(block: HTMLElement): boolean {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return false
    const node = selection.getRangeAt(0).startContainer
    const element =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as HTMLElement)
        : node.parentElement
    if (!element) return false
    const source = getSourcePre(block)
    // Only the source counts as editing. The caret landing in the generated
    // preview must not be read as intent to edit, or the table would flip to
    // source the moment it was clicked.
    return source ? source.contains(element) : block.contains(element)
  }

  function clearPreview(block: HTMLElement): void {
    const preview = getPreview(block)
    if (preview) preview.remove()
  }

  function showSource(block: HTMLElement): void {
    clearPreview(block)
    block.classList.remove('vmd-front-matter-block--rendered')
    const source = getSourcePre(block)
    if (source) source.style.removeProperty('display')
  }

  function renderTable(block: HTMLElement): void {
    const source = getSourceText(block)
    const existing = getPreview(block)
    if (existing?.getAttribute('data-vmd-source') === source) {
      block.classList.add('vmd-front-matter-block--rendered')
      return
    }
    if (existing) existing.remove()

    const preview = document.createElement('div')
    preview.className = PREVIEW_CLASS
    // Vditor treats a preview container as non-editable machinery; marking it so
    // keeps the caret out of the generated table and out of getValue()'s way.
    preview.setAttribute('contenteditable', 'false')
    preview.setAttribute('data-vmd-source', source)
    preview.appendChild(buildTable(source))
    block.appendChild(preview)
    block.classList.add('vmd-front-matter-block--rendered')
  }

  function refresh(): void {
    refreshQueued = false
    if (writing || !root) return

    const block = findBlock(root)
    if (!block) return

    writing = true
    try {
      if (mode === 'codeBlock') {
        showSource(block)
        block.classList.remove('vmd-front-matter-block--hidden')
        return
      }
      if (mode === 'hide') {
        clearPreview(block)
        block.classList.add('vmd-front-matter-block--hidden')
        return
      }
      block.classList.remove('vmd-front-matter-block--hidden')
      if (editing && caretIsInside(block)) {
        showSource(block)
        return
      }
      renderTable(block)
    } finally {
      writing = false
    }
  }

  function queueRefresh(): void {
    if (refreshQueued || writing) return
    refreshQueued = true
    queueMicrotask(refresh)
  }

  function setEditing(next: boolean): void {
    if (editing === next) return
    editing = next
    queueRefresh()
  }

  function onSelectionChange(): void {
    if (!root) return
    const block = findBlock(root)
    setEditing(block ? caretIsInside(block) : false)
  }

  function onRootClick(event: Event): void {
    if (!root) return
    const block = findBlock(root)
    if (!block) return
    const target = event.target as HTMLElement | null
    const preview = getPreview(block)
    if (!target || !preview?.contains(target)) return
    // Clicking the table is a request to edit it: show the source and put the
    // caret in it, since the preview itself is not editable.
    event.preventDefault()
    event.stopImmediatePropagation()
    editing = true
    writing = true
    try {
      showSource(block)
    } finally {
      writing = false
    }
    const code = getSourcePre(block)?.querySelector('code')
    if (code) {
      const range = document.createRange()
      range.selectNodeContents(code)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      ;(code as HTMLElement).focus?.()
    }
  }

  function unbindRoot(): void {
    observer?.disconnect()
    observer = null
    if (boundRoot) {
      boundRoot.removeEventListener('click', onRootClick, true)
      boundRoot = null
    }
    document.removeEventListener('selectionchange', onSelectionChange)
  }

  function rebind(): void {
    const nextRoot = getWysiwygRoot()
    if (nextRoot === root && boundRoot === nextRoot) {
      queueRefresh()
      return
    }

    unbindRoot()
    root = nextRoot
    if (!root) return

    root.addEventListener('click', onRootClick, true)
    boundRoot = root
    document.addEventListener('selectionchange', onSelectionChange)

    observer = new MutationObserver(queueRefresh)
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    editing = false
    queueRefresh()
  }

  rebind()
  return {
    rebind,
    setDisplay(next: FrontMatterDisplay) {
      if (mode === next) return
      mode = next
      // Drop any stale container so the new mode renders from scratch.
      const block = root ? findBlock(root) : null
      if (block) {
        writing = true
        try {
          showSource(block)
        } finally {
          writing = false
        }
      }
      queueRefresh()
    },
    dispose() {
      const block = root ? findBlock(root) : null
      if (block) showSource(block)
      unbindRoot()
      root = null
    },
  }
}
