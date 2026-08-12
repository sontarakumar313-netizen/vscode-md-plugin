export const ALERT_TYPES = [
  'NOTE',
  'TIP',
  'IMPORTANT',
  'WARNING',
  'CAUTION',
] as const

export type AlertType = (typeof ALERT_TYPES)[number]
export type QuoteType = AlertType | null

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

const ALERT_MARKER = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/
const QUOTE_PREFIX = /^> ?/

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
  return line.text.startsWith('>')
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
    while (isQuoteLine(line)) {
      lines.push(line)
      const next = nextSourceLine(source, line)
      if (!next) break
      line = next
    }

    const first = lines[0]
    const marker = ALERT_MARKER.exec(first.text)
    const last = lines[lines.length - 1]
    blocks.push({
      start,
      end: last.end,
      type: marker ? (marker[1] as AlertType) : null,
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
  if (!isQuoteLine(line)) return null
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

function unwrapQuoteBlock(source: string, block: QuoteBlock): string {
  const bodyLines = block.type === null ? block.lines : block.lines.slice(1)
  return bodyLines.map((line) => removeOneQuotePrefix(line.text)).join('\n')
}

function retypeQuoteBlock(
  source: string,
  block: QuoteBlock,
  type: QuoteType
): string {
  const lines = block.lines.map((line) => line.text)
  if (block.type !== null && type !== null) {
    lines[0] = `> [!${type}]`
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
        ? unwrapQuoteBlock(source, block)
        : retypeQuoteBlock(source, block, type)
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

