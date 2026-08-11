/**
 * A read-only parser for the YAML subset that appears in Markdown front matter.
 *
 * Deliberately read-only: nothing here ever serializes a value back. The editor
 * shows the parsed result as a table, and the document keeps the source text it
 * always had, so quoting style, comments, key order and block scalar markers all
 * survive untouched. Anything this parser does not understand is reported as an
 * error instead of guessed at, and the caller falls back to showing the source.
 */

export type FrontMatterValue =
  | { kind: 'scalar'; text: string; type: FrontMatterScalarType }
  | { kind: 'list'; items: FrontMatterValue[] }
  | { kind: 'map'; entries: FrontMatterEntry[] }

export type FrontMatterScalarType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'date'

export interface FrontMatterEntry {
  key: string
  value: FrontMatterValue
}

export interface ParsedFrontMatter {
  entries: FrontMatterEntry[]
  error: string | null
}

const NULL_SCALAR: FrontMatterValue = { kind: 'scalar', text: '', type: 'null' }

// Recognized the way YAML 1.2 core schema does, not by looking plausible: only
// `true`/`false` are booleans, and `null`/`~`/empty are null. Keeping this strict
// is what stops `false` and `null` from being displayed as ordinary strings.
const NUMBER_PATTERN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[-+]\d{2}:?\d{2})?)?$/

function scalarTypeOf(text: string): FrontMatterScalarType {
  if (text === '' || text === 'null' || text === '~') return 'null'
  if (text === 'true' || text === 'false') return 'boolean'
  if (NUMBER_PATTERN.test(text)) return 'number'
  if (DATE_PATTERN.test(text)) return 'date'
  return 'string'
}

/** Strips one layer of matching quotes, and only when they wrap the whole value. */
function unquote(raw: string): { text: string; quoted: boolean } {
  const value = raw.trim()
  if (value.length < 2) return { text: value, quoted: false }
  const first = value[0]
  const last = value[value.length - 1]
  if ((first === '"' || first === "'") && last === first) {
    const inner = value.slice(1, -1)
    return {
      text: first === '"' ? inner.replace(/\\"/g, '"') : inner.replace(/''/g, "'"),
      quoted: true,
    }
  }
  return { text: value, quoted: false }
}

/**
 * Removes a trailing `#` comment. A `#` only opens a comment when whitespace
 * precedes it, so `value # is not a comment` inside quotes and URLs such as
 * `https://example.com/#anchor` are left intact. Quoted values are handed to this
 * function only after quoting has been ruled out.
 */
function stripComment(raw: string): string {
  let inSingle = false
  let inDouble = false
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]
    if (character === "'" && !inDouble) inSingle = !inSingle
    else if (character === '"' && !inSingle) inDouble = !inDouble
    else if (
      character === '#' &&
      !inSingle &&
      !inDouble &&
      (index === 0 || /\s/.test(raw[index - 1]))
    ) {
      return raw.slice(0, index)
    }
  }
  return raw
}

function indentWidth(line: string): number {
  const match = /^[ \t]*/.exec(line)
  return match ? match[0].length : 0
}

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function isComment(line: string): boolean {
  return line.trim().startsWith('#')
}

// Flow collections, anchors, aliases, tags and multi-document markers are all
// valid YAML that this parser does not model. Detected up front so the caller can
// fall back to the source instead of showing a half-read table.
const UNSUPPORTED = [
  { pattern: /^[[{]/, label: 'flow collections' },
  { pattern: /^[&*]/, label: 'anchors and aliases' },
  { pattern: /^!/, label: 'tags' },
]

function describeUnsupported(value: string): string | null {
  for (const { pattern, label } of UNSUPPORTED) {
    if (pattern.test(value)) return label
  }
  return null
}

interface Reader {
  lines: string[]
  index: number
}

/**
 * Reads a `|` or `>` block scalar. The text is folded for `>` and kept verbatim
 * for `|`, following the chomping indicator, because the table has to show what
 * the value actually is rather than the marker that produced it.
 */
function readBlockScalar(reader: Reader, header: string, parentIndent: number): string {
  const style = header[0]
  const chomp = /-/.test(header) ? 'strip' : /\+/.test(header) ? 'keep' : 'clip'
  const collected: string[] = []
  let blockIndent = -1

  while (reader.index < reader.lines.length) {
    const line = reader.lines[reader.index]
    if (isBlank(line)) {
      collected.push('')
      reader.index += 1
      continue
    }
    const width = indentWidth(line)
    if (width <= parentIndent) break
    if (blockIndent === -1) blockIndent = width
    if (width < blockIndent) break
    collected.push(line.slice(blockIndent))
    reader.index += 1
  }

  while (collected.length > 0 && collected[collected.length - 1] === '') {
    collected.pop()
  }
  if (collected.length === 0) return ''

  let text: string
  if (style === '|') {
    text = collected.join('\n')
  } else {
    // Folded: a single break becomes a space, a blank line stays a break.
    text = collected.reduce((accumulator, line, position) => {
      if (position === 0) return line
      if (line === '' || collected[position - 1] === '') {
        return accumulator + '\n' + line
      }
      return accumulator + ' ' + line
    }, '')
  }
  if (chomp !== 'strip') text += '\n'
  return chomp === 'strip' ? text : text.replace(/\n+$/, '\n')
}

function parseInlineValue(raw: string): FrontMatterValue {
  const trimmed = raw.trim()
  if (trimmed === '') return NULL_SCALAR
  const { text, quoted } = unquote(trimmed)
  if (quoted) return { kind: 'scalar', text, type: 'string' }
  const withoutComment = stripComment(trimmed).trim()
  if (withoutComment === '') return NULL_SCALAR
  const unsupported = describeUnsupported(withoutComment)
  if (unsupported) throw new Error(`不支持的 YAML 语法：${unsupported}`)
  const bare = unquote(withoutComment)
  return {
    kind: 'scalar',
    text: bare.text,
    type: bare.quoted ? 'string' : scalarTypeOf(bare.text),
  }
}

/** Parses the block that belongs to `parentIndent`, mapping or sequence. */
function parseBlock(reader: Reader, parentIndent: number): FrontMatterValue {
  const first = nextContentLine(reader)
  if (first === null) return NULL_SCALAR
  const isSequence = /^-(?:\s|$)/.test(first.trim())
  return isSequence
    ? { kind: 'list', items: parseSequence(reader, parentIndent) }
    : { kind: 'map', entries: parseMapping(reader, parentIndent) }
}

function nextContentLine(reader: Reader): string | null {
  let cursor = reader.index
  while (cursor < reader.lines.length) {
    const line = reader.lines[cursor]
    if (!isBlank(line) && !isComment(line)) return line
    cursor += 1
  }
  return null
}

function skipIgnorable(reader: Reader): void {
  while (
    reader.index < reader.lines.length &&
    (isBlank(reader.lines[reader.index]) || isComment(reader.lines[reader.index]))
  ) {
    reader.index += 1
  }
}

function parseSequence(reader: Reader, parentIndent: number): FrontMatterValue[] {
  const items: FrontMatterValue[] = []
  let itemIndent = -1
  for (;;) {
    skipIgnorable(reader)
    if (reader.index >= reader.lines.length) break
    const line = reader.lines[reader.index]
    const width = indentWidth(line)
    if (width <= parentIndent) break
    const body = line.slice(width)
    if (!/^-(?:\s|$)/.test(body)) break
    if (itemIndent === -1) itemIndent = width
    if (width !== itemIndent) {
      throw new Error(`序列缩进不一致：第 ${reader.index + 1} 行`)
    }
    reader.index += 1
    const inline = body.replace(/^-\s*/, '')
    items.push(parseItem(reader, inline, width))
  }
  return items
}

/**
 * A sequence item is either a scalar, a nested block, or a mapping that starts on
 * the dash line itself (`- name: first`) and continues on following lines that
 * line up past the dash.
 */
function parseItem(
  reader: Reader,
  inline: string,
  dashIndent: number
): FrontMatterValue {
  const keyMatch = /^([^:#]+):(?:\s+(.*))?$/.exec(inline.trim())
  if (inline.trim() !== '' && keyMatch) {
    const entries: FrontMatterEntry[] = [
      {
        key: unquote(keyMatch[1]).text,
        value: valueFor(reader, keyMatch[2] ?? '', dashIndent + 1),
      },
    ]
    const continued = parseMapping(reader, dashIndent + 1)
    return { kind: 'map', entries: entries.concat(continued) }
  }
  if (inline.trim() !== '') return parseInlineValue(inline)
  const nested = nextContentLine(reader)
  if (nested !== null && indentWidth(nested) > dashIndent) {
    return parseBlock(reader, dashIndent)
  }
  return NULL_SCALAR
}

/** Resolves the value of `key: <inline>`, descending into a block when needed. */
function valueFor(
  reader: Reader,
  inline: string,
  keyIndent: number
): FrontMatterValue {
  const trimmed = inline.trim()
  if (/^[|>][-+]?\d*$/.test(trimmed)) {
    return {
      kind: 'scalar',
      text: readBlockScalar(reader, trimmed, keyIndent),
      type: 'string',
    }
  }
  if (trimmed !== '' && !trimmed.startsWith('#')) return parseInlineValue(trimmed)
  const nested = nextContentLine(reader)
  if (nested !== null && indentWidth(nested) > keyIndent) {
    return parseBlock(reader, keyIndent)
  }
  return NULL_SCALAR
}

function parseMapping(reader: Reader, parentIndent: number): FrontMatterEntry[] {
  const entries: FrontMatterEntry[] = []
  let keyIndent = -1
  for (;;) {
    skipIgnorable(reader)
    if (reader.index >= reader.lines.length) break
    const line = reader.lines[reader.index]
    const width = indentWidth(line)
    if (width <= parentIndent) break
    if (keyIndent === -1) keyIndent = width
    if (width !== keyIndent) {
      throw new Error(`映射缩进不一致：第 ${reader.index + 1} 行`)
    }
    const body = line.slice(width)
    if (/^-(?:\s|$)/.test(body)) break
    const keyMatch = /^([^:#]+):(?:\s*(.*))?$/.exec(body)
    if (!keyMatch) {
      throw new Error(`无法解析第 ${reader.index + 1} 行`)
    }
    reader.index += 1
    entries.push({
      key: unquote(keyMatch[1]).text,
      value: valueFor(reader, keyMatch[2] ?? '', width),
    })
  }
  return entries
}

export interface FrontMatterBlock {
  /** The YAML between the markers, without either `---` line. */
  body: string
  /** The whole block including both markers and the trailing newline. */
  raw: string
  /** Offset just past the block, where the document body starts. */
  end: number
}

const OPEN_MARKER = /^---[ \t]*(?:\r?\n|$)/
const CLOSE_MARKER = /^(?:---|\.\.\.)[ \t]*$/

/**
 * Finds front matter using the same rule VS Code's Markdown preview applies: the
 * opening `---` must be the very first thing in the document, unindented, and a
 * matching `---` (or `...`) must close it on a line of its own. An unclosed block
 * is not front matter, so a stray `---` mid-document cannot swallow the file.
 */
export function findFrontMatter(markdown: string): FrontMatterBlock | null {
  if (!OPEN_MARKER.test(markdown)) return null
  const lines = markdown.split('\n')
  for (let index = 1; index < lines.length; index += 1) {
    if (!CLOSE_MARKER.test(lines[index].replace(/\r$/, ''))) continue
    const body = lines.slice(1, index).join('\n')
    const raw = lines.slice(0, index + 1).join('\n')
    return { body, raw, end: raw.length }
  }
  return null
}

/**
 * Reads the run of newlines between the closing marker and the first body block,
 * or null when there is no front matter or nothing follows it.
 *
 * Lute normalizes this separator away on every WYSIWYG round trip, turning
 * `---\n\n# Heading` into `---\n# Heading`. That is a cosmetic rewrite of a
 * document the user did not edit, so the pair of functions here remembers the
 * separator on the way in and puts it back on the way out. The separator is not
 * semantic in Markdown, and Lute always collapses it, so the editor could never
 * express "no blank line" anyway: reproducing what the document had is strictly
 * closer to the source than dropping it.
 */
export function frontMatterSeparator(markdown: string): string | null {
  const block = findFrontMatter(markdown)
  if (!block) return null
  const rest = markdown.slice(block.end)
  const match = /^(?:\r?\n)+/.exec(rest)
  if (!match) return null
  // Only a real following block counts. A document that is nothing but front
  // matter has no separator to preserve, just Vditor's trailing newline.
  return /\S/.test(rest.slice(match[0].length)) ? match[0] : null
}

/** Puts a remembered separator back, leaving everything else untouched. */
export function restoreFrontMatterSeparator(
  markdown: string,
  separator: string | null
): string {
  if (!separator) return markdown
  const block = findFrontMatter(markdown)
  if (!block) return markdown
  const rest = markdown.slice(block.end)
  const match = /^(?:\r?\n)*/.exec(rest)
  const current = match ? match[0] : ''
  if (current === separator) return markdown
  const body = rest.slice(current.length)
  if (!/\S/.test(body)) return markdown
  return markdown.slice(0, block.end) + separator + body
}

/**
 * Parses the text between the `---` markers. Never throws: a syntax error becomes
 * `error`, and the caller shows the source instead of a partial table.
 */
export function parseFrontMatter(source: string): ParsedFrontMatter {
  const reader: Reader = { lines: source.split('\n'), index: 0 }
  try {
    const entries = parseMapping(reader, -1)
    skipIgnorable(reader)
    if (reader.index < reader.lines.length) {
      throw new Error(`无法解析第 ${reader.index + 1} 行`)
    }
    return { entries, error: null }
  } catch (error) {
    return {
      entries: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
