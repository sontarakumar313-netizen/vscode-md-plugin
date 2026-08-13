const assert = require('assert')
const Module = require('module')
const path = require('path')
const { buildSync } = require('esbuild')

const sourcePath = path.resolve(
  __dirname,
  '../media-src/src/sv-code-indent.ts'
)
const compiledSource = buildSync({
  entryPoints: [sourcePath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
}).outputFiles[0].text
const compiledModule = new Module(sourcePath)
compiledModule.filename = sourcePath
compiledModule.paths = module.paths
compiledModule._compile(compiledSource, sourcePath)

const { fencedFirstBodyLines, missingIndent } = compiledModule.exports

const FENCE = '`'.repeat(3)
const TILDE = '~'.repeat(3)
const lines = (...values) => values.join('\n')

// --- fencedFirstBodyLines: one entry per block, in document order -------------

assert.deepStrictEqual(
  fencedFirstBodyLines(lines(FENCE + 'js', '    first();', 'second();', FENCE, '')),
  ['    first();'],
  'the first body line of a fenced block must be reported verbatim'
)

assert.deepStrictEqual(
  fencedFirstBodyLines('plain paragraph\n\nanother\n'),
  [],
  'a document without fenced blocks has no first body lines'
)

assert.deepStrictEqual(
  fencedFirstBodyLines(
    lines(
      FENCE,
      '  a();',
      FENCE,
      '',
      'mid',
      '',
      TILDE + 'py',
      '\tb()',
      TILDE,
      ''
    )
  ),
  ['  a();', '\tb()'],
  'blocks must be reported in document order across fence styles'
)

// A fence character inside a body must not open a new block.
assert.deepStrictEqual(
  fencedFirstBodyLines(
    lines(FENCE + 'md', '    ' + TILDE, 'text', '    ' + TILDE, FENCE, '')
  ),
  ['    ' + TILDE],
  'a different fence character inside a body must not be treated as a block'
)

// A longer close is valid; a shorter run is body text.
assert.deepStrictEqual(
  fencedFirstBodyLines(
    lines(FENCE, '    x();', '`'.repeat(5), '', FENCE, '    y();', FENCE, '')
  ),
  ['    x();', '    y();'],
  'a closing fence may be longer than the fence that opened the block'
)

// An unclosed block still renders as a code block, so it still needs an entry.
assert.deepStrictEqual(
  fencedFirstBodyLines(lines(FENCE + 'js', '    dangling();', '')),
  ['    dangling();'],
  'an unclosed block must still contribute its first body line'
)

assert.deepStrictEqual(
  fencedFirstBodyLines(FENCE + 'js'),
  [''],
  'a block that opens at the very end of the input contributes an empty line'
)

assert.deepStrictEqual(
  fencedFirstBodyLines(lines('- item', '', '  ' + FENCE + 'js', '      first();', '  ' + FENCE, '')),
  ['      first();'],
  'an indented fence inside a list is still a block'
)

assert.deepStrictEqual(fencedFirstBodyLines(''), [], 'empty input has no blocks')

// --- missingIndent: only ever restores a pure whitespace prefix ---------------

assert.strictEqual(
  missingIndent('    first();', 'first();'),
  '    ',
  'a dropped four-space indent must be recovered'
)

assert.strictEqual(
  missingIndent('\tfirst();', 'first();'),
  '\t',
  'a dropped tab indent must be recovered as a tab'
)

// Nested blocks arrive with the list padding already re-emitted, so only the
// difference belongs to the repair.
assert.strictEqual(
  missingIndent('      first();', '  first();'),
  '    ',
  'only the whitespace missing beyond re-emitted padding may be restored'
)

assert.strictEqual(
  missingIndent('first();', 'first();'),
  '',
  'an unchanged line needs no repair'
)

assert.strictEqual(
  missingIndent('    first();', '    first();'),
  '',
  'a line that kept its indent needs no repair'
)

// The user's own edits reach the renderer as input, so a genuine dedent shows up
// as an unchanged line and must never be undone.
assert.strictEqual(
  missingIndent('first();', '    first();'),
  '',
  'a rendered line longer than its source must not be trimmed'
)

assert.strictEqual(
  missingIndent('x();', '();'),
  '',
  'a missing head that is not whitespace must not be restored'
)

assert.strictEqual(
  missingIndent('    first();', 'second();'),
  '',
  'unrelated lines must not be spliced together'
)

assert.strictEqual(
  missingIndent('    ', ''),
  '    ',
  'a body line of only whitespace is still recoverable'
)

assert.strictEqual(missingIndent('', ''), '', 'empty lines need no repair')

console.log('split-view code indent tests passed')
