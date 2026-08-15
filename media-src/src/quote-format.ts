export const ALERT_TYPES = [
  'NOTE',
  'TIP',
  'IMPORTANT',
  'WARNING',
  'CAUTION',
] as const

export type AlertType = (typeof ALERT_TYPES)[number]
export type QuoteType = AlertType | null

export function normalizeAlertType(value: unknown): AlertType | null {
  if (typeof value !== 'string') return null
  const normalized = value.toUpperCase()
  return ALERT_TYPES.find((type) => type === normalized) || null
}

export interface SourceLine {
  start: number
  end: number
  text: string
}

export interface QuoteBlock {
  start: number
  end: number
  type: QuoteType
  lines: SourceLine[]
}

export interface QuoteSourceChange {
  content: string
  targetText: string
  targetSourceOffset: number
}

const ALERT_MARKER = /^ {0,3}>[ \t]{0,4}\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+[^\r\n]*)?$/i
const ALERT_MARKER_TYPE = /\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i
const QUOTE_PREFIX = /^ {0,3}> ?/
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/
const BLOCK_START = /^ {0,3}(?:#{1,6}(?:[ \t]+|$)|(?:[-+*]|\d+[.)])[ \t]+|`{3,}|~{3,}|<|>)/
const LIST_ITEM = /^( {0,3})(?:[-+*]|\d+[.)])[ \t]+/
const DETAILS_TAG = /<\/?details(?:\s[^>]*)?>/gi

function alertMarkerType(line: string): AlertType | null {
  return normalizeAlertType(ALERT_MARKER.exec(line)?.[1])
}

function quoteLineContent(line: string): string {
  return line.replace(QUOTE_PREFIX, '')
}

function opensLazyParagraph(line: SourceLine): boolean {
  const content = quoteLineContent(line.text)
  return Boolean(content.trim()) && !BLOCK_START.test(content)
}

function hasAlertBody(lines: SourceLine[]): boolean {
  if (lines.length < 2) return false
  const firstBodyLine = quoteLineContent(lines[1].text)
  if (SETEXT_UNDERLINE.test(firstBodyLine)) return false
  const body = lines
    .slice(1)
    .map((line) => quoteLineContent(line.text))
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '')
  return Boolean(body.trim())
}

export function sourceLineAt(source: string, offset: number): SourceLine {
  const safeOffset = Math.min(Math.max(0, offset), source.length)
  const start = source.lastIndexOf('\n', safeOffset - 1) + 1
  const newline = source.indexOf('\n', start)
  const end = newline < 0 ? source.length : newline
  return { start, end, text: source.slice(start, end) }
}

function nextSourceLine(source: string, line: SourceLine): SourceLine | null {
  if (line.end >= source.length) return null
  return sourceLineAt(source, line.end + 1)
}

function previousSourceLine(source: string, line: SourceLine): SourceLine | null {
  return line.start > 0 ? sourceLineAt(source, line.start - 1) : null
}

function isQuoteLine(line: SourceLine): boolean {
  return QUOTE_PREFIX.test(line.text)
}

export function findQuoteBlocks(source: string): QuoteBlock[] {
  const blocks: QuoteBlock[] = []
  let line = sourceLineAt(source, 0)

  while (true) {
    if (!isQuoteLine(line)) {
      const next = nextSourceLine(source, line)
      if (!next) break
      line = next
      continue
    }

    const lines: SourceLine[] = []
    const start = line.start
    let lazyParagraphOpen = false
    while (isQuoteLine(line) || (lazyParagraphOpen && Boolean(line.text.trim()))) {
      const explicitQuoteLine = isQuoteLine(line)
      lines.push(line)
      lazyParagraphOpen = explicitQuoteLine
        ? opensLazyParagraph(line)
        : Boolean(line.text.trim())
      const next = nextSourceLine(source, line)
      if (!next) break
      line = next
    }

    const first = lines[0]
    const markerType = alertMarkerType(first.text)
    const last = lines[lines.length - 1]
    blocks.push({
      start,
      end: last.end,
      type: markerType && hasAlertBody(lines) ? markerType : null,
      lines,
    })

    if (line.start === last.start) break
  }

  return blocks
}

export function findQuoteBlockAt(
  source: string,
  offset: number
): QuoteBlock | null {
  const line = sourceLineAt(source, offset)
  return (
    findQuoteBlocks(source).find(
      (block) => line.start >= block.start && line.start <= block.end
    ) || null
  )
}

export function stripQuotePrefixes(line: string): string {
  let result = line
  while (QUOTE_PREFIX.test(result)) result = result.replace(QUOTE_PREFIX, '')
  return result
}

export function quoteDepth(line: string): number {
  let depth = 0
  let result = line
  while (QUOTE_PREFIX.test(result)) {
    depth += 1
    result = result.replace(QUOTE_PREFIX, '')
  }
  return depth
}

function isInsideDetails(source: string, offset: number): boolean {
  const prefix = source.slice(0, offset)
  let depth = 0
  for (const match of prefix.matchAll(DETAILS_TAG)) {
    depth += /^<\/details/i.test(match[0]) ? -1 : 1
    depth = Math.max(0, depth)
  }
  return depth > 0
}

/** Whether the Alert toolbar can produce a top-level GitHub Alert here. */
export function isTopLevelAlertLocation(
  source: string,
  lineStart: number
): boolean {
  const line = sourceLineAt(source, lineStart)
  const depth = quoteDepth(line.text)
  if (depth > 1 || isInsideDetails(source, line.start)) return false

  const content = stripQuotePrefixes(line.text)
  if (LIST_ITEM.test(content)) return false

  const currentIndent = /^ */.exec(line.text)?.[0].length || 0
  let previous = line.start > 0
    ? sourceLineAt(source, line.start - 1)
    : null
  while (previous && previous.text.trim()) {
    const previousContent = stripQuotePrefixes(previous.text)
    const list = LIST_ITEM.exec(previousContent)
    const previousIndent = /^ */.exec(previous.text)?.[0].length || 0
    if (
      list &&
      quoteDepth(previous.text) === depth &&
      previousIndent + list[1].length < currentIndent
    ) {
      return false
    }
    previous = previous.start > 0
      ? sourceLineAt(source, previous.start - 1)
      : null
  }
  return true
}

function replaceSourceRange(
  source: string,
  start: number,
  end: number,
  replacement: string
): string {
  return source.slice(0, start) + replacement + source.slice(end)
}

function quoteBodyLine(line: string): string {
  return `> ${line}`
}

function buildQuotedLine(
  line: string,
  type: QuoteType
): { markdown: string; targetOffset: number } {
  if (type === null) {
    return { markdown: quoteBodyLine(line), targetOffset: 2 }
  }
  const marker = `> [!${type}]\n`
  return {
    markdown: marker + quoteBodyLine(line),
    targetOffset: marker.length + 2,
  }
}

function removeOneQuotePrefix(line: string): string {
  return line.replace(QUOTE_PREFIX, '')
}

function unwrapQuoteBlock(block: QuoteBlock): string {
  const bodyLines = block.type === null ? block.lines : block.lines.slice(1)
  return bodyLines.map((line) => removeOneQuotePrefix(line.text)).join('\n')
}

function retypeQuoteBlock(
  block: QuoteBlock,
  type: QuoteType
): string {
  const lines = block.lines.map((line) => line.text)
  if (block.type !== null && type !== null) {
    lines[0] = lines[0].replace(ALERT_MARKER_TYPE, `[!${type}]`)
    return lines.join('\n')
  }
  if (block.type !== null) return lines.slice(1).join('\n')
  return [`> [!${type}]`, ...lines].join('\n')
}

function findTargetOffset(
  replacement: string,
  targetText: string,
  fallback: number
): number {
  if (!targetText) return fallback
  const index = replacement.indexOf(targetText)
  return index < 0 ? fallback : index
}

export function toggleQuoteAt(
  source: string,
  lineStart: number,
  type: QuoteType,
  emptyTemplateBody: string,
  targetText: string
): QuoteSourceChange {
  const block = findQuoteBlockAt(source, lineStart)
  if (block) {
    const replacement =
      block.type === type
        ? unwrapQuoteBlock(block)
        : retypeQuoteBlock(block, type)
    const targetInReplacement = findTargetOffset(replacement, targetText, 0)
    return {
      content: replaceSourceRange(source, block.start, block.end, replacement),
      targetText,
      targetSourceOffset: block.start + targetInReplacement,
    }
  }

  const line = sourceLineAt(source, lineStart)
  const body = line.text.trim() ? line.text : emptyTemplateBody
  const quoted = buildQuotedLine(body, type)
  return {
    content: replaceSourceRange(source, line.start, line.end, quoted.markdown),
    targetText: line.text.trim() ? targetText : emptyTemplateBody,
    targetSourceOffset: line.start + quoted.targetOffset,
  }
}

function quoteRangeBounds(
  source: string,
  start: number,
  end: number
): { start: number; end: number } {
  const first = sourceLineAt(source, start)
  const last = sourceLineAt(
    source,
    end > first.start ? Math.max(first.start, end - 1) : first.start
  )
  return { start: first.start, end: last.end }
}

function quoteBlockForRange(
  source: string,
  start: number,
  end: number
): QuoteBlock | null {
  return findQuoteBlocks(source).find(
    (block) => block.start === start && block.end === end
  ) || null
}

function isAlertMarkerLine(line: string): boolean {
  return alertMarkerType(line) !== null
}

function normalizeQuotedRangeLine(line: string): string {
  const content = stripQuotePrefixes(line)
  return content.trim() ? quoteBodyLine(content) : '>'
}

function buildQuotedRange(lines: string[], type: QuoteType): string {
  const bodyLines = lines.filter((line) => !isAlertMarkerLine(line))
  const body = bodyLines.map(normalizeQuotedRangeLine).join('\n')
  return type === null ? body : `> [!${type}]\n${body}`
}

/** Toggles every complete source line touched by a multi-line selection. */
export function toggleQuoteRangeAt(
  source: string,
  start: number,
  end: number,
  type: QuoteType,
  targetText: string
): QuoteSourceChange {
  const range = quoteRangeBounds(source, start, end)
  const block = quoteBlockForRange(source, range.start, range.end)
  if (block) {
    return toggleQuoteAt(source, block.start, type, '', targetText)
  }

  const lines = source.slice(range.start, range.end).split('\n')
  const hasAlertMarker = lines.some(isAlertMarkerLine)
  const allQuoted = lines.every(
    (line) => !line.trim() || QUOTE_PREFIX.test(line)
  )
  const replacement =
    type === null && allQuoted && !hasAlertMarker
      ? lines
        .map((line) => line.trim() ? removeOneQuotePrefix(line) : '')
        .join('\n')
      : buildQuotedRange(lines, type)
  const targetInReplacement = findTargetOffset(replacement, targetText, 0)
  return {
    content: replaceSourceRange(
      source,
      range.start,
      range.end,
      replacement
    ),
    targetText,
    targetSourceOffset: range.start + targetInReplacement,
  }
}

/** Toggles one default NOTE Alert over a complete multi-line selection. */
export function toggleDefaultAlertRangeAt(
  source: string,
  start: number,
  end: number,
  targetText: string
): QuoteSourceChange {
  const range = quoteRangeBounds(source, start, end)
  const activeType = quoteBlockForRange(source, range.start, range.end)?.type
  return toggleQuoteRangeAt(
    source,
    range.start,
    range.end,
    activeType ?? 'NOTE',
    targetText
  )
}

/** Toggles one default NOTE Alert button, regardless of the active Alert type. */
export function toggleDefaultAlertAt(
  source: string,
  lineStart: number,
  emptyTemplateBody: string,
  targetText: string
): QuoteSourceChange {
  const activeType = findQuoteBlockAt(source, lineStart)?.type
  return toggleQuoteAt(
    source,
    lineStart,
    activeType ?? 'NOTE',
    emptyTemplateBody,
    targetText
  )
}

function hasQuoteParagraphContent(line: SourceLine): boolean {
  return Boolean(stripQuotePrefixes(line.text).trim())
}

/** Complete source lines represented by the same compact quote paragraph. */
function quoteParagraphAt(source: string, line: SourceLine): SourceLine[] {
  const depth = quoteDepth(line.text)
  let first = line
  let previous = previousSourceLine(source, first)
  while (
    previous &&
    quoteDepth(previous.text) === depth &&
    hasQuoteParagraphContent(previous) &&
    hasQuoteParagraphContent(first)
  ) {
    first = previous
    previous = previousSourceLine(source, first)
  }

  const lines = [first]
  let current = first
  let next = nextSourceLine(source, current)
  while (
    next &&
    quoteDepth(next.text) === depth &&
    hasQuoteParagraphContent(current) &&
    hasQuoteParagraphContent(next)
  ) {
    lines.push(next)
    current = next
    next = nextSourceLine(source, current)
  }
  return lines
}

export function adjustPlainQuoteDepthAt(
  source: string,
  lineStart: number,
  outdent: boolean
): QuoteSourceChange | null {
  const block = findQuoteBlockAt(source, lineStart)
  if (!block || block.type !== null) return null

  const line = sourceLineAt(source, lineStart)
  const depth = quoteDepth(line.text)
  if (depth === 0 || (outdent && depth === 1)) return null

  const paragraph = quoteParagraphAt(source, line)
  const targetLineIndex = paragraph.findIndex(
    (candidate) => candidate.start === line.start
  )
  if (targetLineIndex < 0) return null

  const transformedLines = paragraph.map((candidate) =>
    outdent
      ? removeOneQuotePrefix(candidate.text)
      : `> ${candidate.text}`
  )
  const replacement = transformedLines.join('\n')
  const targetText = stripQuotePrefixes(line.text)
  const precedingLength = transformedLines
    .slice(0, targetLineIndex)
    .reduce((length, text) => length + text.length + 1, 0)
  const targetInLine = transformedLines[targetLineIndex]?.indexOf(targetText) ?? -1

  const first = paragraph[0]
  const last = paragraph[paragraph.length - 1]
  let replacementEnd = last.end
  if (outdent) {
    const next = nextSourceLine(source, last)
    if (
      next &&
      quoteDepth(next.text) >= depth &&
      !hasQuoteParagraphContent(next)
    ) {
      replacementEnd = next.end
    }
  }

  return {
    content: replaceSourceRange(
      source,
      first.start,
      replacementEnd,
      replacement
    ),
    targetText,
    targetSourceOffset:
      first.start + precedingLength + Math.max(0, targetInLine),
  }
}

