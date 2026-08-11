/**
 * Split View drops the indentation of the first line inside every fenced code
 * block.
 *
 * Lute's split-view renderer emits the body of a fenced code block one line at a
 * time, and the first line loses its leading whitespace on the way out. Later
 * lines survive, so a block that was indented throughout arrives ragged: a body
 * of "    first();" then "    second();" renders as "first();" then
 * "    second();".
 *
 * The same happens through every entry point, because they all funnel into
 * `SpinVditorSVDOM`: switching the mode to Split View, typing, pasting, and
 * accepting a hint. Split View reads its value straight back out of the DOM
 * (`getMarkdown` returns `sv.element.textContent`), so the loss is not cosmetic.
 * It becomes the document: switch to Split View and back, type one character, and
 * the flattened text is what gets saved.
 *
 * The repair puts the whitespace back into the rendered markup, which fixes what
 * the user sees and what the editor reports in one move. The amount to restore is
 * derived from the very input Lute was handed, never from a remembered earlier
 * version of the document, so a deliberate dedent by the user is preserved: their
 * keystroke is already part of that input.
 *
 * Two deliberate limits:
 *   - Repairs are skipped wholesale unless the number of fenced blocks in the
 *     input matches the number of code blocks in the output. Lute rewrites
 *     indented code blocks into fenced ones, which makes the two counts disagree;
 *     bailing out is better than pairing up the wrong blocks.
 *   - The rendered markup is patched as a string rather than re-serialized from a
 *     DOM. Vditor's own post-processing matches on Lute's exact `<br />` spelling,
 *     which a DOM round-trip would silently rewrite to `<br>`.
 */

const FENCE_PATTERN = /^(\s*)(`{3,}|~{3,})/

/**
 * The first body line of every fenced code block in `source`, in document order.
 * Blocks that open at the very end of the input contribute an empty string, so
 * the result stays index-aligned with the blocks Lute will render.
 */
export function fencedFirstBodyLines(source: string): string[] {
  const lines = source.split('\n')
  const firstLines: string[] = []
  let index = 0
  while (index < lines.length) {
    const opening = FENCE_PATTERN.exec(lines[index])
    if (!opening) {
      index += 1
      continue
    }
    const marker = opening[2]
    const fenceCharacter = marker[0]
    firstLines.push(lines[index + 1] ?? '')
    index += 1
    // Walk to the matching close so a fence character inside the body cannot be
    // mistaken for the start of another block.
    while (index < lines.length) {
      const closing = FENCE_PATTERN.exec(lines[index])
      const isClose =
        closing &&
        closing[2][0] === fenceCharacter &&
        closing[2].length >= marker.length &&
        lines[index].slice(closing[0].length).trim() === ''
      index += 1
      if (isClose) break
    }
  }
  return firstLines
}

/**
 * The leading whitespace `renderedLine` lost relative to `sourceLine`, or an
 * empty string when the two do not differ by exactly a whitespace prefix. The
 * rendered line must be passed with any block padding Lute re-emitted around it
 * already included, so a code block nested in a list is measured as a whole.
 */
export function missingIndent(sourceLine: string, renderedLine: string): string {
  if (sourceLine === renderedLine) return ''
  if (!sourceLine.endsWith(renderedLine)) return ''
  const head = sourceLine.slice(0, sourceLine.length - renderedLine.length)
  if (head === '' || /\S/.test(head)) return ''
  return head
}

const BODY_TEXT_TAG = '<span data-type="text">'
const OPEN_MARKER_ATTRIBUTE = 'data-type="code-block-open-marker"'

interface PendingRepair {
  offset: number
  indent: string
}

/**
 * Reads the rendered first line of each code block, including the padding Lute
 * emits before it for nested blocks, together with the offset at which restored
 * whitespace has to be spliced back into `html`.
 */
function measureRenderedBlocks(
  html: string
): { renderedLine: string; offset: number }[] {
  const container = document.createElement('div')
  container.innerHTML = html
  const markers = Array.from(
    container.querySelectorAll(`[${OPEN_MARKER_ATTRIBUTE}]`)
  )
  const blocks: { renderedLine: string; offset: number }[] = []
  let searchFrom = 0
  for (const marker of markers) {
    let padding = ''
    let body: Element | null = marker.nextElementSibling
    while (body && body.getAttribute('data-type') !== 'text') {
      if (body.getAttribute('data-type') === 'padding') {
        padding += body.textContent || ''
      }
      body = body.nextElementSibling
    }
    if (!body) return []
    // Locate the same body span in the raw markup. Both walks visit the blocks in
    // document order, so a single forward scan keeps them aligned.
    const markerOffset = html.indexOf(OPEN_MARKER_ATTRIBUTE, searchFrom)
    if (markerOffset === -1) return []
    const bodyOffset = html.indexOf(BODY_TEXT_TAG, markerOffset)
    if (bodyOffset === -1) return []
    searchFrom = bodyOffset + BODY_TEXT_TAG.length
    blocks.push({
      renderedLine: padding + (body.textContent || '').split('\n')[0],
      offset: searchFrom,
    })
  }
  return blocks
}

/**
 * Restores the first-line indentation Lute's split-view renderer dropped.
 * `input` is whatever was handed to the renderer: the document's Markdown on a
 * mode switch, or the current Split View markup while editing.
 */
export function repairSvCodeIndent(html: string, input: unknown): string {
  if (typeof html !== 'string' || html === '') return html
  if (typeof input !== 'string' || input === '') return html
  if (!html.includes(OPEN_MARKER_ATTRIBUTE)) return html

  const source = sourceTextOf(input)
  const sourceLines = fencedFirstBodyLines(source)
  if (sourceLines.length === 0) return html
  if (!sourceLines.some((line) => /^[ \t]/.test(line))) return html

  const blocks = measureRenderedBlocks(html)
  if (blocks.length !== sourceLines.length) return html

  const repairs: PendingRepair[] = []
  blocks.forEach((block, index) => {
    const indent = missingIndent(sourceLines[index], block.renderedLine)
    if (indent !== '') repairs.push({ offset: block.offset, indent })
  })
  if (repairs.length === 0) return html

  let repaired = html
  // Back to front, so an earlier splice cannot shift a later offset.
  for (let index = repairs.length - 1; index >= 0; index -= 1) {
    const { offset, indent } = repairs[index]
    repaired = repaired.slice(0, offset) + indent + repaired.slice(offset)
  }
  return repaired
}

/**
 * Split View hands the renderer its own markup while editing and plain Markdown
 * on a mode switch. Recover the Markdown either way, and drop the caret marker
 * Lute threads through the text so it cannot break the comparison.
 */
function sourceTextOf(input: string): string {
  let source = input
  if (input.includes('data-type="')) {
    const container = document.createElement('div')
    container.innerHTML = input
    source = container.textContent || ''
  }
  const caret = (window as any).Lute?.Caret
  if (typeof caret === 'string' && caret !== '') {
    source = source.split(caret).join('')
  }
  return source
}

/**
 * Wraps the split-view renderers on a Lute instance so every Split View render
 * keeps its code indentation. Safe to call more than once per instance.
 */
export function installSvCodeIndentRepair(lute: any): void {
  if (!lute || lute.__vmdSvCodeIndentPatched) return
  for (const method of ['SpinVditorSVDOM', 'Md2VditorSVDOM']) {
    const original = lute[method]
    if (typeof original !== 'function') continue
    lute[method] = function patched(this: unknown, input: string) {
      return repairSvCodeIndent(original.call(this, input), input)
    }
  }
  lute.__vmdSvCodeIndentPatched = true
}
