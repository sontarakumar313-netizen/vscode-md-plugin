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

  const replacement = outdent
    ? removeOneQuotePrefix(line.text)
    : `> ${line.text}`
  const targetText = stripQuotePrefixes(line.text)
  const targetInReplacement = replacement.indexOf(targetText)
  return {
    content: replaceSourceRange(source, line.start, line.end, replacement),
    targetText,
    targetSourceOffset:
      line.start + (targetInReplacement < 0 ? 0 : targetInReplacement),
  }
}

