type MathDelimiter = 'latex' | 'dollar'

interface MathPair {
  open: number
  close: number
  content: string
}

interface MathSnapshot {
  content: string
  delimiter: MathDelimiter
}

interface NormalizedMarkdown {
  markdown: string
  latexIndexes: Set<number>
}

interface SourceRange {
  start: number
  end: number
}

interface FindMathPairOptions {
  protectedRanges?: SourceRange[]
  isDelimiter?: (source: string, index: number) => boolean
  singleLine?: boolean
}

interface VditorValueApi {
  getValue(): string
  setValue(markdown: string, clearStack?: boolean): void
}

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i--) {
    backslashes++
  }
  return backslashes % 2 === 1
}

function getLineEnd(source: string, start: number): number {
  const lineEnd = source.indexOf('\n', start)
  return lineEnd === -1 ? source.length : lineEnd
}

function getFenceMarker(line: string): string | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r$/, ''))
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null
  return match[1]
}

function isClosingFence(line: string, marker: string): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line.replace(/\r$/, ''))
  return !!(
    match &&
    match[1][0] === marker[0] &&
    match[1].length >= marker.length
  )
}

function skipRawCodeElement(source: string, index: number): number | null {
  if (source.startsWith('<!--', index)) {
    const end = source.indexOf('-->', index + 4)
    return end === -1 ? source.length : end + 3
  }

  const match = /^<(pre|code|script|style)\b[^>]*>/i.exec(source.slice(index))
  if (!match) return null

  const closingTag = `</${match[1].toLowerCase()}>`
  const end = source.toLowerCase().indexOf(closingTag, index + match[0].length)
  return end === -1 ? source.length : end + closingTag.length
}

/**
 * Finds paired math delimiters while ignoring Markdown code spans, fenced code
 * blocks, HTML comments, and raw HTML code-like elements.
 */
function findMathPairs(
  source: string,
  opening: string,
  closing: string,
  options: FindMathPairOptions = {}
): MathPair[] {
  const pairs: MathPair[] = []
  const protectedRanges = [...(options.protectedRanges || [])].sort(
    (left, right) => left.start - right.start
  )
  let protectedRangeIndex = 0
  let open = -1
  let fence = ''
  let codeTicks = 0
  let i = 0

  while (i < source.length) {
    while (
      protectedRangeIndex < protectedRanges.length &&
      protectedRanges[protectedRangeIndex].end <= i
    ) {
      protectedRangeIndex++
    }
    const protectedRange = protectedRanges[protectedRangeIndex]
    if (
      protectedRange &&
      i >= protectedRange.start &&
      i < protectedRange.end
    ) {
      i = protectedRange.end
      continue
    }

    if (open !== -1) {
      if (options.singleLine && source[i] === '\n') {
        open = -1
        i++
        continue
      }
      if (
        source.startsWith(closing, i) &&
        !isEscaped(source, i) &&
        (!options.isDelimiter || options.isDelimiter(source, i))
      ) {
        pairs.push({
          open,
          close: i,
          content: source.slice(open + opening.length, i),
        })
        open = -1
        i += closing.length
      } else {
        i++
      }
      continue
    }

    const isLineStart = i === 0 || source[i - 1] === '\n'
    if (isLineStart && codeTicks === 0) {
      const lineEnd = getLineEnd(source, i)
      const line = source.slice(i, lineEnd)
      if (fence) {
        if (isClosingFence(line, fence)) fence = ''
        i = lineEnd < source.length ? lineEnd + 1 : lineEnd
        continue
      }

      const marker = getFenceMarker(line)
      if (marker) {
        fence = marker
        i = lineEnd < source.length ? lineEnd + 1 : lineEnd
        continue
      }
    }

    if (source[i] === '`') {
      let runLength = 1
      while (source[i + runLength] === '`') runLength++
      if (codeTicks === 0) codeTicks = runLength
      else if (codeTicks === runLength) codeTicks = 0
      i += runLength
      continue
    }

    if (codeTicks > 0) {
      i++
      continue
    }

    if (source[i] === '<') {
      const afterElement = skipRawCodeElement(source, i)
      if (afterElement !== null) {
        i = afterElement
        continue
      }
    }

    if (
      source.startsWith(opening, i) &&
      !isEscaped(source, i) &&
      (!options.isDelimiter || options.isDelimiter(source, i))
    ) {
      open = i
      i += opening.length
      continue
    }

    i++
  }

  return pairs
}

function getDisplayMathPairs(markdown: string): MathPair[] {
  return findMathPairs(markdown, '$$', '$$')
}

function toRanges(pairs: MathPair[], closingLength: number): SourceRange[] {
  return pairs.map((pair) => ({
    start: pair.open,
    end: pair.close + closingLength,
  }))
}

function isSingleDollar(source: string, index: number): boolean {
  return source[index - 1] !== '$' && source[index + 1] !== '$'
}

function getInlineMathPairs(markdown: string): MathPair[] {
  const displayPairs = getDisplayMathPairs(markdown)
  return findMathPairs(markdown, '$', '$', {
    protectedRanges: toRanges(displayPairs, 2),
    isDelimiter: isSingleDollar,
    singleLine: true,
  })
}

function getDollarMathRanges(markdown: string): SourceRange[] {
  return [
    ...toRanges(getDisplayMathPairs(markdown), 2),
    ...toRanges(getInlineMathPairs(markdown), 1),
  ]
}

function replaceDelimiters(
  markdown: string,
  pairs: MathPair[],
  originalClosing: string,
  opening: string,
  closing: string
): string {
  if (pairs.length === 0) return markdown

  let result = ''
  let cursor = 0
  pairs.forEach((pair) => {
    result += markdown.slice(cursor, pair.open)
    result += opening
    result += pair.content
    result += closing
    cursor = pair.close + originalClosing.length
  })
  return result + markdown.slice(cursor)
}

function normalizePairs(
  markdown: string,
  pairs: MathPair[],
  originalClosing: string,
  targetOpening: string,
  targetClosing: string,
  getTargetPairs: (value: string) => MathPair[]
): NormalizedMarkdown {
  if (pairs.length === 0) {
    return { markdown, latexIndexes: new Set<number>() }
  }

  let normalized = ''
  let cursor = 0
  const convertedOpenOffsets = new Set<number>()
  pairs.forEach((pair) => {
    normalized += markdown.slice(cursor, pair.open)
    convertedOpenOffsets.add(normalized.length)
    normalized += targetOpening
    normalized += pair.content
    normalized += targetClosing
    cursor = pair.close + originalClosing.length
  })
  normalized += markdown.slice(cursor)

  const latexIndexes = new Set<number>()
  getTargetPairs(normalized).forEach((pair, index) => {
    if (convertedOpenOffsets.has(pair.open)) latexIndexes.add(index)
  })

  return { markdown: normalized, latexIndexes }
}

function normalizeBracketMath(markdown: string): NormalizedMarkdown {
  const bracketPairs = findMathPairs(markdown, '\\[', '\\]', {
    protectedRanges: getDollarMathRanges(markdown),
  })
  return normalizePairs(
    markdown,
    bracketPairs,
    '\\]',
    '$$',
    '$$',
    getDisplayMathPairs
  )
}

function normalizeParenMath(markdown: string): NormalizedMarkdown {
  const parenPairs = findMathPairs(markdown, '\\(', '\\)', {
    protectedRanges: getDollarMathRanges(markdown),
    singleLine: true,
  })
  return normalizePairs(
    markdown,
    parenPairs,
    '\\)',
    '$',
    '$',
    getInlineMathPairs
  )
}

function canonicalMathContent(content: string): string {
  return content.replace(/\r\n?/g, '\n').trim()
}

function reconcileDelimiters(
  previous: MathSnapshot[],
  current: string[]
): MathDelimiter[] {
  const delimiters = current.map<MathDelimiter>(() => 'dollar')
  const previousByContent = new Map<string, number[]>()
  const usedPrevious = new Set<number>()
  const matchedCurrent = new Set<number>()

  previous.forEach((item, index) => {
    const indexes = previousByContent.get(item.content) || []
    indexes.push(index)
    previousByContent.set(item.content, indexes)
  })

  // Keep the style attached to unchanged formulas even if blocks move.
  current.forEach((content, currentIndex) => {
    const previousIndex = (previousByContent.get(content) || []).find(
      (index) => !usedPrevious.has(index)
    )
    if (previousIndex === undefined) return
    delimiters[currentIndex] = previous[previousIndex].delimiter
    usedPrevious.add(previousIndex)
    matchedCurrent.add(currentIndex)
  })

  // When the number of formulas did not change, unmatched items are ordinary
  // in-place edits. Pair those remaining items in order to preserve their style.
  if (previous.length === current.length) {
    const remainingPrevious = previous
      .map((_item, index) => index)
      .filter((index) => !usedPrevious.has(index))
    const remainingCurrent = current
      .map((_item, index) => index)
      .filter((index) => !matchedCurrent.has(index))
    remainingCurrent.forEach((currentIndex, index) => {
      delimiters[currentIndex] = previous[remainingPrevious[index]].delimiter
    })
  }

  return delimiters
}

/**
 * Lets Vditor render LaTeX display and inline delimiters through its native
 * $$ ... $$ and $ ... $ parsers while preserving the original \[ ... \] and
 * \( ... \) styles when Markdown leaves the webview.
 */
export class LatexMathCompatibility {
  private displaySnapshot: MathSnapshot[] = []
  private inlineSnapshot: MathSnapshot[] = []

  public prepare(markdown: string): string {
    const bracketNormalized = normalizeBracketMath(markdown || '')
    const parenNormalized = normalizeParenMath(bracketNormalized.markdown)

    this.displaySnapshot = getDisplayMathPairs(parenNormalized.markdown).map(
      (pair, index) => ({
        content: canonicalMathContent(pair.content),
        delimiter: bracketNormalized.latexIndexes.has(index) ? 'latex' : 'dollar',
      })
    )
    this.inlineSnapshot = getInlineMathPairs(parenNormalized.markdown).map(
      (pair, index) => ({
        content: canonicalMathContent(pair.content),
        delimiter: parenNormalized.latexIndexes.has(index) ? 'latex' : 'dollar',
      })
    )
    return parenNormalized.markdown
  }

  public attach(editor: VditorValueApi): void {
    const getValue = editor.getValue.bind(editor)
    const setValue = editor.setValue.bind(editor)

    editor.getValue = () => this.restore(getValue())
    editor.setValue = (markdown: string, clearStack?: boolean) => {
      setValue(this.prepare(markdown), clearStack)
    }
  }

  private restore(markdown: string): string {
    const displayPairs = getDisplayMathPairs(markdown)
    const displayContents = displayPairs.map((pair) =>
      canonicalMathContent(pair.content)
    )
    const displayDelimiters = reconcileDelimiters(
      this.displaySnapshot,
      displayContents
    )
    const inlinePairs = getInlineMathPairs(markdown)
    const inlineContents = inlinePairs.map((pair) =>
      canonicalMathContent(pair.content)
    )
    const inlineDelimiters = reconcileDelimiters(
      this.inlineSnapshot,
      inlineContents
    )

    this.displaySnapshot = displayContents.map((content, index) => ({
      content,
      delimiter: displayDelimiters[index],
    }))
    this.inlineSnapshot = inlineContents.map((content, index) => ({
      content,
      delimiter: inlineDelimiters[index],
    }))

    const latexDisplayPairs = displayPairs.filter(
      (_pair, index) => displayDelimiters[index] === 'latex'
    )
    const latexInlinePairs = inlinePairs.filter(
      (_pair, index) => inlineDelimiters[index] === 'latex'
    )
    const withDisplayDelimiters = replaceDelimiters(
      markdown,
      latexDisplayPairs,
      '$$',
      '\\[',
      '\\]'
    )
    return replaceDelimiters(
      withDisplayDelimiters,
      latexInlinePairs,
      '$',
      '\\(',
      '\\)'
    )
  }
}
