const assert = require('assert')
const Module = require('module')
const path = require('path')
const { buildSync } = require('esbuild')

const sourcePath = path.resolve(__dirname, '../media-src/src/quote-format.ts')
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

const {
  adjustPlainQuoteDepthAt,
  findQuoteBlockAt,
  sourceLineAt,
  toggleQuoteAt,
} = compiledModule.exports

function content(change) {
  return change.content
}

const nonEmpty = 'before\ncurrent line\nafter'
const currentLine = sourceLineAt(nonEmpty, nonEmpty.indexOf('current'))
assert.strictEqual(
  content(toggleQuoteAt(nonEmpty, currentLine.start, null, 'Quote content', 'current line')),
  'before\n> current line\nafter',
  'plain quote must transform the caret line instead of inserting a template'
)
assert.strictEqual(
  content(toggleQuoteAt(nonEmpty, currentLine.start, 'NOTE', 'Alert content', 'current line')),
  'before\n> [!NOTE]\n> current line\nafter',
  'GitHub Alert must transform the caret line instead of inserting a template'
)

const empty = 'before\n\nafter'
const emptyLine = sourceLineAt(empty, 'before\n'.length)
assert.strictEqual(
  content(toggleQuoteAt(empty, emptyLine.start, null, 'Quote content', '')),
  'before\n> Quote content\nafter',
  'plain quote template is allowed only for an empty caret line'
)
assert.strictEqual(
  content(toggleQuoteAt(empty, emptyLine.start, 'WARNING', 'Alert content', '')),
  'before\n> [!WARNING]\n> Alert content\nafter',
  'Alert template is allowed only for an empty caret line'
)

const plainQuote = '> first\n> second'
const plainBlock = findQuoteBlockAt(plainQuote, plainQuote.indexOf('second'))
assert.ok(plainBlock)
assert.strictEqual(
  content(toggleQuoteAt(plainQuote, plainQuote.indexOf('second'), null, 'Quote content', 'second')),
  'first\nsecond',
  'clicking the active plain quote must toggle it off'
)
assert.strictEqual(
  content(toggleQuoteAt(plainQuote, plainQuote.indexOf('second'), 'TIP', 'Alert content', 'second')),
  '> [!TIP]\n> first\n> second',
  'plain quote must switch to an Alert in place'
)

const warning = '> [!WARNING]\n> body'
assert.strictEqual(
  content(toggleQuoteAt(warning, warning.indexOf('body'), 'TIP', 'Alert content', 'body')),
  '> [!TIP]\n> body',
  'Alert type must switch in place'
)
assert.strictEqual(
  content(toggleQuoteAt(warning, warning.indexOf('body'), null, 'Quote content', 'body')),
  '> body',
  'Alert must switch to a plain quote in place'
)
assert.strictEqual(
  content(toggleQuoteAt(warning, warning.indexOf('body'), 'WARNING', 'Alert content', 'body')),
  'body',
  'clicking the active Alert must toggle it off'
)

const duplicateAlerts = '> [!NOTE]\n> first\n\n> [!NOTE]\n> second'
assert.strictEqual(
  content(toggleQuoteAt(
    duplicateAlerts,
    duplicateAlerts.lastIndexOf('second'),
    'TIP',
    'Alert content',
    'second'
  )),
  '> [!NOTE]\n> first\n\n> [!TIP]\n> second',
  'switching a repeated Alert type must change the block at the caret'
)

const multiLine = '> first\n> second'
assert.strictEqual(
  content(adjustPlainQuoteDepthAt(multiLine, multiLine.indexOf('second'), false)),
  '> first\n> > second',
  'Tab must add one marker only to the caret line'
)
const nested = '> first\n> > second'
assert.strictEqual(
  content(adjustPlainQuoteDepthAt(nested, nested.indexOf('second'), true)),
  '> first\n> second',
  'Shift+Tab must remove one marker only from the caret line'
)
assert.strictEqual(
  adjustPlainQuoteDepthAt('> only', 0, true),
  null,
  'Shift+Tab must preserve the final quote marker'
)
assert.strictEqual(
  adjustPlainQuoteDepthAt('> [!NOTE]\n> body', 0, false),
  null,
  'GitHub Alerts must not support Tab nesting'
)

console.log('quote format tests passed')
