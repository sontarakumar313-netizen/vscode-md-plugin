import type { EditorSelectionContext } from './caret-anchor'
import { getVditorInternals } from './vditor-adapter'
import { findInnermostDetailsBlocks } from './wysiwyg-details'

export interface DetailsSelectionRange {
  start: number
  end: number
}

interface LuteBlockConverter {
  Md2VditorDOM(markdown: string): string
  VditorDOM2Md(html: string): string
}

type MappedBlock = DetailsSelectionRange

function getBlockConverter(): LuteBlockConverter | null {
  const lute = getVditorInternals()?.lute as Partial<LuteBlockConverter> | undefined
  return lute &&
    typeof lute.Md2VditorDOM === 'function' &&
    typeof lute.VditorDOM2Md === 'function'
    ? (lute as LuteBlockConverter)
    : null
}

function directBlocks(root: HTMLElement): HTMLElement[] {
  return Array.from(root.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement
  )
}

function serializedBlockSource(
  converter: LuteBlockConverter,
  block: HTMLElement
): string {
  return String(converter.VditorDOM2Md(block.outerHTML)).replace(/\r\n?/g, '\n')
}

/** Maps rendered top-level blocks back to their exact spans in current Markdown. */
function mapBlocksToSource(
  source: string,
  blocks: HTMLElement[],
  converter: LuteBlockConverter
): Array<MappedBlock | null> | null {
  const mapped: Array<MappedBlock | null> = []
  let searchOffset = 0

  for (const element of blocks) {
    const serialized = serializedBlockSource(converter, element)
    const body = serialized.replace(/\n+$/, '')
    if (!body) {
      mapped.push(null)
      continue
    }

    const start = source.indexOf(body, searchOffset)
    if (start < 0) return null
    const end = start + body.length
    mapped.push({ start, end })
    searchOffset = end
  }

  return mapped
}

function rangeOverlapsElement(range: Range, element: HTMLElement): boolean {
  const elementRange = document.createRange()
  elementRange.selectNodeContents(element)
  return (
    range.compareBoundaryPoints(Range.START_TO_END, elementRange) > 0 &&
    range.compareBoundaryPoints(Range.END_TO_START, elementRange) < 0
  )
}

function selectedBlockIndexes(
  blocks: HTMLElement[],
  range: Range
): { start: number; end: number } | null {
  const indexes = blocks
    .map((block, index) => rangeOverlapsElement(range, block) ? index : -1)
    .filter((index) => index >= 0)
  return indexes.length > 0
    ? { start: indexes[0], end: indexes[indexes.length - 1] }
    : null
}

/** A touched existing details region must stay structurally complete. */
function expandDetailsIndexes(
  root: HTMLElement,
  blocks: HTMLElement[],
  initial: { start: number; end: number }
): { start: number; end: number } {
  let start = initial.start
  let end = initial.end
  let changed = true

  while (changed) {
    changed = false
    for (let index = start; index <= end; index += 1) {
      const group = findInnermostDetailsBlocks(root, blocks[index])
      if (!group || group.length === 0) continue
      const groupStart = blocks.indexOf(group[0])
      const groupEnd = blocks.indexOf(group[group.length - 1])
      if (groupStart >= 0 && groupStart < start) {
        start = groupStart
        changed = true
      }
      if (groupEnd > end) {
        end = groupEnd
        changed = true
      }
    }
  }

  return { start, end }
}

function sourceRangeForIndexes(
  mapped: Array<MappedBlock | null>,
  indexes: { start: number; end: number }
): DetailsSelectionRange | null {
  let first: MappedBlock | null = null
  let last: MappedBlock | null = null
  for (let index = indexes.start; index <= indexes.end; index += 1) {
    const block = mapped[index]
    if (!block) continue
    if (!first) first = block
    last = block
  }
  return first && last ? { start: first.start, end: last.end } : null
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\u200b/g, '')
}

/** Maps Split View's rendered source prefix to a Markdown source offset. */
function sourceOffsetForVisiblePrefix(
  source: string,
  visiblePrefix: string
): number | null {
  let sourceOffset = 0
  let visibleOffset = 0
  while (visibleOffset < visiblePrefix.length) {
    const sourceCharacter = source[sourceOffset]
    const visibleCharacter = visiblePrefix[visibleOffset]
    if (sourceCharacter === visibleCharacter) {
      sourceOffset += 1
      visibleOffset += 1
      continue
    }
    if (
      sourceCharacter === '\n' &&
      source[sourceOffset + 1] === '\n' &&
      visibleCharacter === '\n'
    ) {
      sourceOffset += 2
      visibleOffset += 1
      continue
    }
    return null
  }
  return sourceOffset
}

function visiblePrefixAt(
  root: HTMLElement,
  container: Node,
  offset: number
): string {
  const before = document.createRange()
  before.selectNodeContents(root)
  before.setEnd(container, offset)
  return normalizeVisibleText(before.toString())
}

function virtualWysiwygRoot(
  source: string,
  converter: LuteBlockConverter,
  ownerDocument: Document
): HTMLElement {
  const root = ownerDocument.createElement('div')
  root.innerHTML = String(converter.Md2VditorDOM(source))
  return root
}

function resolveWysiwygSelection(
  source: string,
  context: EditorSelectionContext,
  converter: LuteBlockConverter
): DetailsSelectionRange | null {
  const blocks = directBlocks(context.root)
  const selected = selectedBlockIndexes(blocks, context.range)
  if (!selected) return null
  const expanded = expandDetailsIndexes(context.root, blocks, selected)
  const mapped = mapBlocksToSource(source, blocks, converter)
  return mapped ? sourceRangeForIndexes(mapped, expanded) : null
}

function resolveSourceViewSelection(
  source: string,
  context: EditorSelectionContext,
  converter: LuteBlockConverter
): DetailsSelectionRange | null {
  const start = sourceOffsetForVisiblePrefix(
    source,
    visiblePrefixAt(
      context.root,
      context.range.startContainer,
      context.range.startOffset
    )
  )
  const end = sourceOffsetForVisiblePrefix(
    source,
    visiblePrefixAt(
      context.root,
      context.range.endContainer,
      context.range.endOffset
    )
  )
  if (start === null || end === null || start >= end) return null

  const virtualRoot = virtualWysiwygRoot(source, converter, context.root.ownerDocument)
  const blocks = directBlocks(virtualRoot)
  const mapped = mapBlocksToSource(source, blocks, converter)
  if (!mapped) return null

  let first = -1
  let last = -1
  mapped.forEach((block, index) => {
    if (!block || block.start >= end || block.end <= start) return
    if (first < 0) first = index
    last = index
  })
  if (first < 0 || last < 0) return null

  const expanded = expandDetailsIndexes(
    virtualRoot,
    blocks,
    { start: first, end: last }
  )
  return sourceRangeForIndexes(mapped, expanded)
}

/** Expands a non-empty editor selection to complete Markdown block boundaries. */
export function resolveDetailsSelectionRange(
  source: string,
  context: EditorSelectionContext | null
): DetailsSelectionRange | null {
  if (!context || context.range.collapsed) return null
  const converter = getBlockConverter()
  if (!converter) return null
  return context.mode === 'wysiwyg'
    ? resolveWysiwygSelection(source, context, converter)
    : resolveSourceViewSelection(source, context, converter)
}
