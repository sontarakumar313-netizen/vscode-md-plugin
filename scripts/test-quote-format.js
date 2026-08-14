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
  isTopLevelAlertLocation,
  sourceLineAt,
  toggleDefaultAlertAt,
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
assert.strictEqual(
  content(toggleDefaultAlertAt(warning, warning.indexOf('body'), 'Alert content', 'body')),
  'body',
  'the unified Alert button must remove an active Alert of any type'
)
assert.strictEqual(
  content(toggleDefaultAlertAt(plainQuote, plainQuote.indexOf('second'), 'Alert content', 'second')),
  '> [!NOTE]\n> first\n> second',
  'the unified Alert button must convert a plain quote to the default Note type'
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

const lowercaseAlert = '> [!note]\n> lowercase body'
assert.strictEqual(
  findQuoteBlockAt(lowercaseAlert, lowercaseAlert.indexOf('body'))?.type,
  'NOTE',
  'GitHub Alert types must be recognized case-insensitively'
)

const customTitleAlert = '> [!NOTE] 自定义标题\n> custom title body'
assert.strictEqual(
  findQuoteBlockAt(customTitleAlert, customTitleAlert.indexOf('body'))?.type,
  'NOTE',
  'an Alert marker with a custom plain-text title must be recognized'
)
assert.strictEqual(
  content(toggleQuoteAt(
    customTitleAlert,
    customTitleAlert.indexOf('body'),
    'TIP',
    'Alert content',
    'custom title body'
  )),
  '> [!TIP] 自定义标题\n> custom title body',
  'switching an Alert type must preserve its custom title'
)

const markerOnly = '> [!NOTE]'
assert.strictEqual(
  findQuoteBlockAt(markerOnly, 0)?.type,
  null,
  'an Alert marker without body content must remain a plain quote'
)

const lazyAlert = '> [!WaRnInG]\nlazy body'
const lazyBlock = findQuoteBlockAt(lazyAlert, lazyAlert.indexOf('body'))
assert.strictEqual(
  lazyBlock?.type,
  'WARNING',
  'a GitHub Alert must include a lazy-continuation body line'
)
assert.strictEqual(
  lazyBlock?.lines.length,
  2,
  'the lazy-continuation body must belong to the source Alert block'
)

assert.strictEqual(
  isTopLevelAlertLocation('> > [!NOTE]\n> > nested body', 0),
  false,
  'the Alert toolbar must reject a nested quote location'
)
const detailsAlert = '<details>\n\ninside details\n\n</details>'
assert.strictEqual(
  isTopLevelAlertLocation(detailsAlert, detailsAlert.indexOf('inside')),
  false,
  'the Alert toolbar must reject a details location'
)
const listAlert = '- item\n  continued item'
assert.strictEqual(
  isTopLevelAlertLocation(listAlert, listAlert.indexOf('continued')),
  false,
  'the Alert toolbar must reject a list continuation location'
)
assert.strictEqual(
  isTopLevelAlertLocation('   > [!NOTE]\n   > body', 0),
  true,
  'an indented top-level blockquote must remain eligible for Alert toggling'
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
