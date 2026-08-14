import {
  ALERT_CLASS,
  ALERT_ICONS,
  ALERT_TITLE_CLASS,
  alertTitle,
  parseAlertMarker,
} from './alert-presentation'
import type { ParsedAlertMarker } from './alert-presentation'
import { findFrontMatter } from './front-matter'
import { buildFrontMatterTable } from './front-matter-presentation'
import { ALERT_TYPES } from './quote-format'
import type { FrontMatterDisplay } from './wysiwyg-front-matter'
import {
  getVditorMode,
  getVditorSplitElements,
} from './vditor-adapter'

const FRONT_MATTER_CLASS = 'vmd-split-front-matter'
const FRONT_MATTER_SOURCE_SELECTOR =
  ':scope > pre.vditor-yml-front-matter'
const ALERT_TYPE_CLASSES = ALERT_TYPES.map(
  (type) => `${ALERT_CLASS}--${type.toLowerCase()}`
)

interface SplitPreviewEditor {
  getValue(): string
}

function renderFrontMatter(
  root: HTMLElement,
  markdown: string,
  display: FrontMatterDisplay
): void {
  const frontMatter = findFrontMatter(markdown)
  const native = root.querySelector<HTMLElement>(FRONT_MATTER_SOURCE_SELECTOR)
  const existing = root.querySelector<HTMLElement>(
    `:scope > .${FRONT_MATTER_CLASS}`
  )

  if (!frontMatter) {
    existing?.remove()
    return
  }

  if (display === 'hide') {
    native?.remove()
    existing?.remove()
    return
  }

  if (
    existing?.getAttribute('data-vmd-source') === frontMatter.body &&
    existing.getAttribute('data-vmd-mode') === display
  ) {
    native?.remove()
    return
  }

  const presentation = document.createElement('div')
  presentation.className = FRONT_MATTER_CLASS
  presentation.setAttribute('data-vmd-source', frontMatter.body)
  presentation.setAttribute('data-vmd-mode', display)

  if (display === 'codeBlock') {
    const raw = document.createElement('pre')
    raw.className = 'vmd-front-matter__code'
    raw.textContent = frontMatter.body
    presentation.appendChild(raw)
  } else {
    presentation.appendChild(buildFrontMatterTable(frontMatter.body))
  }

  existing?.remove()
  if (native) {
    native.replaceWith(presentation)
  } else {
    root.prepend(presentation)
  }
}

interface PreviewMarkerLine {
  parsed: ParsedAlertMarker
  nodes: ChildNode[]
  separator: HTMLBRElement | null
}

/** Reads the first rendered quote line, retaining its DOM nodes for removal. */
function previewMarkerLine(paragraph: HTMLElement): PreviewMarkerLine | null {
  const nodes: ChildNode[] = []
  let text = ''
  let cursor: ChildNode | null = paragraph.firstChild
  let separator: HTMLBRElement | null = null

  while (cursor) {
    if (cursor instanceof HTMLBRElement) {
      separator = cursor
      break
    }
    nodes.push(cursor)
    text += cursor.textContent || ''
    cursor = cursor.nextSibling
  }

  const parsed = parseAlertMarker(text)
  return parsed ? { parsed, nodes, separator } : null
}

function removeMarkerLine(line: PreviewMarkerLine): void {
  line.nodes.forEach((node) => node.remove())
  line.separator?.remove()
}

function removeEmptyParagraph(paragraph: HTMLElement): void {
  if (
    paragraph.childElementCount === 0 &&
    !(paragraph.textContent || '').replace(/[\u200b\ufeff]/g, '').trim()
  ) {
    paragraph.remove()
  }
}

function hasAlertBody(
  blockquote: HTMLElement,
  paragraph: HTMLElement
): boolean {
  const clone = blockquote.cloneNode(true) as HTMLElement
  const paragraphIndex = Array.from(blockquote.children).indexOf(paragraph)
  const clonedParagraph = clone.children.item(paragraphIndex)
  if (!(clonedParagraph instanceof HTMLElement)) return false

  const line = previewMarkerLine(clonedParagraph)
  if (!line) return false
  removeMarkerLine(line)
  removeEmptyParagraph(clonedParagraph)

  const visibleText = (clone.textContent || '')
    .replace(/[\u200b\ufeff]/g, '')
    .trim()
  if (visibleText) return true

  // Empty text can still contain a meaningful media, rule, table, or raw HTML
  // body. BR and P alone only represent the marker line's layout.
  return Array.from(clone.querySelectorAll('*')).some(
    (element) => element.tagName !== 'P' && element.tagName !== 'BR'
  )
}

function decorateAlert(blockquote: HTMLElement): void {
  if (
    blockquote.classList.contains(ALERT_CLASS) &&
    blockquote.querySelector(`:scope > .${ALERT_TITLE_CLASS}`)
  ) {
    return
  }

  const first = blockquote.firstElementChild
  if (!(first instanceof HTMLElement) || first.tagName !== 'P') return
  const line = previewMarkerLine(first)
  if (!line || !hasAlertBody(blockquote, first)) return

  removeMarkerLine(line)
  removeEmptyParagraph(first)

  const { customTitle, type } = line.parsed
  blockquote.classList.remove(...ALERT_TYPE_CLASSES)
  blockquote.classList.add(
    ALERT_CLASS,
    `${ALERT_CLASS}--${type.toLowerCase()}`
  )
  blockquote.setAttribute('data-vmd-alert', type)

  const title = document.createElement('div')
  title.className = `${ALERT_TITLE_CLASS} vmd-split-alert-title`
  title.setAttribute('data-vmd-alert-type', type)
  title.innerHTML = ALERT_ICONS[type]
  const label = document.createElement('span')
  label.textContent = customTitle || alertTitle(type)
  title.appendChild(label)
  blockquote.prepend(title)
}

/** Applies read-only Front Matter and GitHub Alert presentation to Split View. */
export function renderSplitPreviewPresentation(
  editor: SplitPreviewEditor,
  display: FrontMatterDisplay
): void {
  if (getVditorMode(editor) !== 'sv') return
  const root = getVditorSplitElements(editor)?.previewContent
  if (!root) return

  const value = editor.getValue()
  if (typeof value !== 'string') return
  renderFrontMatter(root, value, display)
  root
    .querySelectorAll<HTMLElement>(':scope > blockquote')
    .forEach(decorateAlert)
}
