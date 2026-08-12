import type { EditorSelectionContext } from './caret-anchor'
import {
  findTextOccurrence,
  getVisibleTextBeforeElement,
} from './caret-anchor'
import {
  findQuoteBlocks,
  sourceLineAt,
  stripQuotePrefixes,
} from './quote-format'
import type { QuoteBlock, SourceLine } from './quote-format'
import {
  getVditorEditorElement,
  getVditorInternals,
  getVditorMode,
} from './vditor-adapter'

const LINE_ELEMENT_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, pre, td, th'

interface SourceViewOffsetMap {
  sourceOffset: number
  sourceText: string
}

export interface ResolvedCaretLine {
  line: SourceLine
  quoteBlock: QuoteBlock | null
  renderedText: string
  renderedOffset: number
}

export interface EditorLineAnchor {
  text: string
  offset: number
  occurrence: number
}

interface RenderedLine {
  element: HTMLElement
  index: number
  text: string
}

function asElement(node: Node): HTMLElement | null {
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as HTMLElement)
    : node.parentElement
}

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\u200b/g, '')
}

function sourceViewOffset(
  source: string,
  visibleBefore: string
): SourceViewOffsetMap | null {
  let sourceOffset = 0
  let visibleOffset = 0
  while (visibleOffset < visibleBefore.length) {
    const sourceChar = source[sourceOffset]
    const visibleChar = visibleBefore[visibleOffset]
    if (sourceChar === visibleChar) {
      sourceOffset += 1
      visibleOffset += 1
      continue
    }
    // Vditor's source view renders one visual newline between block wrappers
    // for the blank separator that exists only in serialized Markdown.
    if (
      sourceChar === '\n' &&
      source[sourceOffset + 1] === '\n' &&
      visibleChar === '\n'
    ) {
      sourceOffset += 2
      visibleOffset += 1
      continue
    }
    return null
  }
  return {
    sourceOffset,
    sourceText: source.slice(0, sourceOffset),
  }
}

function lineElementAt(context: EditorSelectionContext): HTMLElement | null {
  const element = asElement(context.range.startContainer)
  const line = element?.closest<HTMLElement>(LINE_ELEMENT_SELECTOR) || null
  return line && context.root.contains(line) ? line : null
}

function renderedLineAt(context: EditorSelectionContext): RenderedLine | null {
  const element = lineElementAt(context)
  if (!element) return null

  const before = document.createRange()
  before.selectNodeContents(element)
  before.setEnd(context.range.startContainer, context.range.startOffset)
  const beforeText = normalizeText(before.toString())
  const text = normalizeText(element.textContent || '')
  const beforeLines = beforeText.split('\n')
  const lines = text.split('\n')
  const index = Math.min(beforeLines.length - 1, Math.max(0, lines.length - 1))
  return {
    element,
    index,
    text: lines[index] || '',
  }
}

function renderedOffsetAt(context: EditorSelectionContext): number {
  const element = lineElementAt(context)
  if (!element) return 0
  const before = document.createRange()
  before.selectNodeContents(element)
  before.setEnd(context.range.startContainer, context.range.startOffset)
  const text = normalizeText(before.toString())
  const newline = text.lastIndexOf('\n')
  return text.length - newline - 1
}

function outermostBlockquote(
  context: EditorSelectionContext
): HTMLElement | null {
  let current = asElement(context.range.startContainer)?.closest<HTMLElement>(
    'blockquote'
  ) || null
  if (!current || !context.root.contains(current)) return null

  while (true) {
    const parent = current.parentElement?.closest<HTMLElement>('blockquote') || null
    if (!parent || !context.root.contains(parent)) return current
    current = parent
  }
}

function outerBlockquotes(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('blockquote')).filter(
    (blockquote) => {
      const parent = blockquote.parentElement?.closest('blockquote')
      return !parent || !root.contains(parent)
    }
  )
}

function sourceQuoteBlock(
  source: string,
  context: EditorSelectionContext
): QuoteBlock | null {
  const blockquote = outermostBlockquote(context)
  if (!blockquote) return null
  const index = outerBlockquotes(context.root).indexOf(blockquote)
  return index < 0 ? null : findQuoteBlocks(source)[index] || null
}

function comparableLine(value: string): string {
  return normalizeText(value).trim()
}

function renderedMarkdownLine(
  context: EditorSelectionContext,
  line: SourceLine
): string {
  const internals = getVditorInternals()
  const lute = internals?.lute
  if (!lute || typeof lute.Md2VditorDOM !== 'function') return ''
  const container = context.root.ownerDocument.createElement('div')
  container.innerHTML = lute.Md2VditorDOM(line.text)
  return normalizeText(container.textContent || '')
}

function occurrenceBeforeLine(
  root: HTMLElement,
  current: RenderedLine,
  query: string
): number {
  if (!query) return 0
  const before = document.createRange()
  before.selectNodeContents(root)
  before.setEndBefore(current.element)
  const previousInElement = normalizeText(current.element.textContent || '')
    .split('\n')
    .slice(0, current.index)
    .join('\n')
  const priorText = `${normalizeText(before.toString())}\n${previousInElement}`
  let occurrence = 0
  let offset = 0
  while ((offset = priorText.indexOf(query, offset)) >= 0) {
    occurrence += 1
    offset += Math.max(1, query.length)
  }
  return occurrence
}

function resolveQuoteLine(
  context: EditorSelectionContext,
  block: QuoteBlock,
  rendered: RenderedLine
): SourceLine | null {
  const query = comparableLine(rendered.text)
  const candidates = block.lines.filter((line, index) => {
    if (index === 0 && block.type !== null) return false
    const sourceText = comparableLine(stripQuotePrefixes(line.text))
    const renderedText = comparableLine(renderedMarkdownLine(context, line))
    return sourceText === query || renderedText === query
  })
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]

  const blockquote = outermostBlockquote(context)
  if (!blockquote) return candidates[0]
  const occurrence = occurrenceBeforeLine(blockquote, rendered, rendered.text)
  return candidates[Math.min(occurrence, candidates.length - 1)]
}

function allSourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = []
  let line = sourceLineAt(source, 0)
  while (true) {
    lines.push(line)
    if (line.end >= source.length) break
    line = sourceLineAt(source, line.end + 1)
  }
  return lines
}

function emptySourceLineForElement(
  source: string,
  context: EditorSelectionContext,
  element: HTMLElement
): SourceLine | null {
  const topLevelBlock = element.closest<HTMLElement>('[data-block="0"]')
  if (!topLevelBlock || topLevelBlock.parentElement !== context.root) return null

  const blocks = Array.from(context.root.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement
  )
  const blockIndex = blocks.indexOf(topLevelBlock)
  if (blockIndex < 0) return null

  const lines = allSourceLines(source)
  let sourceLineIndex = 0
  for (let index = 0; index < blockIndex; index += 1) {
    const previousText = comparableLine(editableText(blocks[index]))
    if (!previousText) {
      while (
        sourceLineIndex < lines.length &&
        lines[sourceLineIndex].text !== ''
      ) {
        sourceLineIndex += 1
      }
      if (sourceLineIndex >= lines.length) return null
      // WYSIWYG can expose several consecutive empty paragraphs while Lute
      // serializes them as one Markdown blank line. Consume the next source
      // line only when it is another real empty line; otherwise let adjacent
      // empty DOM blocks safely share the collapsed insertion position.
      if (lines[sourceLineIndex + 1]?.text === '') {
        sourceLineIndex += 1
      }
      continue
    }
    while (
      sourceLineIndex < lines.length &&
      !comparableLine(lines[sourceLineIndex].text).includes(previousText)
    ) {
      sourceLineIndex += 1
    }
    if (sourceLineIndex >= lines.length) return null
    sourceLineIndex += 1
  }

  while (sourceLineIndex < lines.length && lines[sourceLineIndex].text !== '') {
    sourceLineIndex += 1
  }
  return lines[sourceLineIndex] || null
}

function resolvePlainLine(
  source: string,
  context: EditorSelectionContext,
  rendered: RenderedLine
): SourceLine | null {
  const query = comparableLine(rendered.text)
  if (!query) {
    if (!source.trim()) return sourceLineAt(source, 0)
    return emptySourceLineForElement(source, context, rendered.element)
  }

  const candidates = allSourceLines(source).filter(
    (line) => !line.text.startsWith('>') && comparableLine(line.text).includes(query)
  )
  if (candidates.length === 0) {
    const visibleBefore = getVisibleTextBeforeElement(context, rendered.element)
    const occurrence = occurrenceBeforeLine(
      context.root,
      rendered,
      rendered.text
    )
    const offset = findTextOccurrence(source, rendered.text, occurrence)
    return offset < 0
      ? null
      : sourceLineAt(source, Math.max(visibleBefore.length, offset))
  }
  if (candidates.length === 1) return candidates[0]

  const occurrence = occurrenceBeforeLine(
    context.root,
    rendered,
    rendered.text
  )
  return candidates[Math.min(occurrence, candidates.length - 1)]
}

export function resolveCaretLine(
  source: string,
  context: EditorSelectionContext
): ResolvedCaretLine | null {
  if (context.mode === 'sv') {
    const blockElement = asElement(context.range.startContainer)?.closest<HTMLElement>(
      '[data-block="0"]'
    ) || null
    if (!blockElement || !context.root.contains(blockElement)) return null
    const previousBlocks = Array.from(
      context.root.querySelectorAll<HTMLElement>(':scope > [data-block="0"]')
    )
    const blockIndex = previousBlocks.indexOf(blockElement)
    if (blockIndex < 0) return null

    let blockSourceOffset = 0
    for (let index = 0; index < blockIndex; index += 1) {
      const previousText = normalizeText(previousBlocks[index].textContent || '')
      const mappedPrevious = sourceViewOffset(
        source.slice(blockSourceOffset),
        previousText
      )
      if (!mappedPrevious) return null
      blockSourceOffset += mappedPrevious.sourceOffset
    }

    const before = document.createRange()
    before.selectNodeContents(blockElement)
    before.setEnd(context.range.startContainer, context.range.startOffset)
    const visibleBefore = normalizeText(before.toString())
    const mapped = sourceViewOffset(source.slice(blockSourceOffset), visibleBefore)
    if (!mapped) return null
    const sourceOffset = blockSourceOffset + mapped.sourceOffset
    const line = sourceLineAt(source, sourceOffset)
    const prefixLength = line.text.length - stripQuotePrefixes(line.text).length
    return {
      line,
      quoteBlock:
        findQuoteBlocks(source).find(
          (block) => line.start >= block.start && line.start <= block.end
        ) || null,
      renderedText: stripQuotePrefixes(line.text),
      renderedOffset: Math.max(
        0,
        sourceOffset - line.start - prefixLength
      ),
    }
  }

  const rendered = renderedLineAt(context)
  if (!rendered) return null
  const quoteBlock = sourceQuoteBlock(source, context)
  const line = quoteBlock
    ? resolveQuoteLine(context, quoteBlock, rendered)
    : resolvePlainLine(source, context, rendered)
  if (!line) return null
  return {
    line,
    quoteBlock,
    renderedText: rendered.text,
    renderedOffset: renderedOffsetAt(context),
  }
}

function editableText(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement
  clone
    .querySelectorAll('.vmd-alert-marker, .vmd-alert-title, [contenteditable="false"]')
    .forEach((item) => item.remove())
  return normalizeText(clone.textContent || '')
}

function renderedLines(root: HTMLElement): RenderedLine[] {
  const lines: RenderedLine[] = []
  root.querySelectorAll<HTMLElement>(LINE_ELEMENT_SELECTOR).forEach((element) => {
    if (element.closest('.vmd-alert-title, .vmd-alert-marker')) return
    editableText(element)
      .split('\n')
      .forEach((text, index) => lines.push({ element, index, text }))
  })
  return lines
}

export function captureEditorLineAnchor(
  context: EditorSelectionContext
): EditorLineAnchor | null {
  const current = renderedLineAt(context)
  if (!current) return null
  const matches = renderedLines(context.root).filter(
    (line) => line.text === current.text
  )
  const occurrence = Math.max(
    0,
    matches.findIndex(
      (line) => line.element === current.element && line.index === current.index
    )
  )
  return {
    text: current.text,
    offset: renderedOffsetAt(context),
    occurrence,
  }
}

function textPosition(
  element: HTMLElement,
  offset: number
): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement
        return parent?.closest(
          '.vmd-alert-marker, .vmd-alert-title, [contenteditable="false"]'
        )
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT
      },
    }
  )
  let remaining = Math.max(0, offset)
  let last: Text | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    last = text
    if (remaining <= text.data.length) {
      return { node: text, offset: remaining }
    }
    remaining -= text.data.length
  }
  return last ? { node: last, offset: last.data.length } : null
}

export function createSourceViewAnchor(
  source: string,
  text: string,
  sourceOffset: number,
  renderedOffset: number
): EditorLineAnchor {
  let occurrence = 0
  let offset = 0
  while ((offset = source.indexOf(text, offset)) >= 0 && offset < sourceOffset) {
    occurrence += 1
    offset += Math.max(1, text.length)
  }
  return {
    text,
    offset: Math.min(renderedOffset, text.length),
    occurrence,
  }
}

export function restoreSourceViewAnchor(
  editor: unknown,
  anchor: EditorLineAnchor
): boolean {
  const root = getVditorEditorElement(editor)
  const internals = getVditorInternals(editor)
  const mode = getVditorMode(editor)
  if (!root || !internals || mode !== 'sv' || !anchor.text) return false

  const source = normalizeText(root.textContent || '')
  let start = 0
  for (let index = 0; index <= anchor.occurrence; index += 1) {
    start = source.indexOf(anchor.text, start)
    if (start < 0) return false
    if (index < anchor.occurrence) start += Math.max(1, anchor.text.length)
  }
  const position = textPosition(
    root,
    start + Math.min(anchor.offset, anchor.text.length)
  )
  if (!position) return false

  root.focus({ preventScroll: true })
  const selection = window.getSelection()
  if (!selection) return false
  selection.setBaseAndExtent(
    position.node,
    position.offset,
    position.node,
    position.offset
  )
  if (selection.rangeCount === 0) return false
  internals.sv.range = selection.getRangeAt(0).cloneRange()
  return true
}

export function restoreEditorLineAnchor(
  editor: unknown,
  anchor: EditorLineAnchor
): boolean {
  const root = getVditorEditorElement(editor)
  const internals = getVditorInternals(editor)
  const mode = getVditorMode(editor)
  if (!root || !internals || mode !== 'wysiwyg') return false

  const matches = renderedLines(root).filter((line) => line.text === anchor.text)
  const target = matches[Math.min(anchor.occurrence, matches.length - 1)]
  if (!target) return false

  const priorLength = editableText(target.element)
    .split('\n')
    .slice(0, target.index)
    .reduce((length, line) => length + line.length + 1, 0)
  const position = textPosition(
    target.element,
    priorLength + Math.min(anchor.offset, target.text.length)
  )
  if (!position) return false

  root.focus({ preventScroll: true })
  const selection = window.getSelection()
  if (!selection) return false
  selection.setBaseAndExtent(
    position.node,
    position.offset,
    position.node,
    position.offset
  )
  if (selection.rangeCount === 0) return false
  internals.wysiwyg.range = selection.getRangeAt(0).cloneRange()
  return true
}
