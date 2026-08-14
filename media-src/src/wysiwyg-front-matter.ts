import {
  frontMatterSeparator,
  parseFrontMatter,
  restoreFrontMatterSeparator,
} from './front-matter'
import type { FrontMatterEntry, FrontMatterValue } from './front-matter'
import { registerWysiwygDomFeature } from './wysiwyg-dom'
import {
  closeActiveWysiwygPopover,
  hideWysiwygSerializerSource,
  openWysiwygSourceEditSession,
} from './wysiwyg-popover'

/**
 * Shows YAML front matter as a table or read-only code preview in WYSIWYG mode.
 * The serializer-owned `<pre><code>` always stays hidden and is edited through
 * the shared popover. Generated previews live in a container Lute skips when it
 * serializes the DOM, so display-only controls cannot leak into Markdown.
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
    // Invalid YAML must show its raw projection clearly rather than silently
    // presenting an empty or partially parsed table.
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
  let writing = false

  function clearPreview(block: HTMLElement): void {
    getPreview(block)?.remove()
  }

  function renderPreview(block: HTMLElement): void {
    const source = getSourceText(block)
    const existing = getPreview(block)
    if (
      existing?.getAttribute('data-vmd-source') === source &&
      existing.getAttribute('data-vmd-mode') === mode
    ) {
      block.classList.add('vmd-front-matter-block--rendered')
      const sourcePre = getSourcePre(block)
      if (sourcePre) hideWysiwygSerializerSource(sourcePre)
      return
    }
    existing?.remove()

    const preview = document.createElement('div')
    preview.className = PREVIEW_CLASS
    preview.setAttribute('contenteditable', 'false')
    preview.setAttribute('data-vmd-source', source)
    preview.setAttribute('data-vmd-mode', mode)
    if (mode === 'codeBlock') {
      const raw = document.createElement('pre')
      raw.className = 'vmd-front-matter__code'
      raw.textContent = source
      preview.appendChild(raw)
    } else {
      preview.appendChild(buildTable(source))
    }
    block.appendChild(preview)
    block.classList.add('vmd-front-matter-block--rendered')
    const sourcePre = getSourcePre(block)
    if (sourcePre) hideWysiwygSerializerSource(sourcePre)
  }

  function refresh(root: HTMLElement): void {
    if (writing) return
    const block = findBlock(root)
    if (!block) return

    writing = true
    try {
      const sourcePre = getSourcePre(block)
      if (sourcePre) hideWysiwygSerializerSource(sourcePre)
      if (mode === 'hide') {
        clearPreview(block)
        block.classList.remove('vmd-front-matter-block--rendered')
        block.classList.add('vmd-front-matter-block--hidden')
        return
      }
      block.classList.remove('vmd-front-matter-block--hidden')
      renderPreview(block)
    } finally {
      writing = false
    }
  }

  function openEditor(block: HTMLElement): void {
    const sourcePre = getSourcePre(block)
    const sourceCode = sourcePre?.querySelector<HTMLElement>(':scope > code')
    if (!sourcePre || !sourceCode) return
    const initial = sourceCode.textContent || ''

    openWysiwygSourceEditSession({
      target: block,
      focusField: 'source',
      fields: [
        {
          name: 'source',
          label: 'Front Matter YAML',
          value: initial,
          multiline: true,
        },
      ],
      unavailableMessage: 'The Front Matter block is no longer available',
      isAvailable: () => sourceCode.isConnected,
      onChange: (values) => {
        sourceCode.textContent = values.source ?? ''
        hideWysiwygSerializerSource(sourcePre)
        writing = true
        try {
          renderPreview(block)
        } finally {
          writing = false
        }
        return null
      },
      isSourceChanged: () => sourceCode.textContent !== initial,
      beforeCommit: () => hideWysiwygSerializerSource(sourcePre),
      afterCommit: () => registration.requestRefresh(),
    })
  }

  const registration = registerWysiwygDomFeature({
    refresh,
    onPointerDown: (event, root) => {
      if (mode === 'hide') return false
      const target = event.target instanceof Element ? event.target : null
      const block = findBlock(root)
      const preview = block ? getPreview(block) : null
      if (!target || !preview?.contains(target)) return false
      event.preventDefault()
      event.stopImmediatePropagation()
      return true
    },
    onClick: (event, root) => {
      if (mode === 'hide') return false
      const block = findBlock(root)
      const preview = block ? getPreview(block) : null
      const target = event.target instanceof Element ? event.target : null
      if (!block || !target || !preview?.contains(target)) return false
      event.preventDefault()
      event.stopImmediatePropagation()
      openEditor(block)
      return true
    },
  })

  return {
    setDisplay(next: FrontMatterDisplay): void {
      if (mode === next) return
      closeActiveWysiwygPopover()
      mode = next
      registration.requestRefresh()
    },
  }
}
