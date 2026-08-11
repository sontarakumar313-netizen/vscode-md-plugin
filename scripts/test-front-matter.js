const assert = require('assert')
const fs = require('fs')
const Module = require('module')
const path = require('path')
const { buildSync } = require('esbuild')

const sourcePath = path.resolve(__dirname, '../media-src/src/front-matter.ts')
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
  parseFrontMatter,
  findFrontMatter,
  frontMatterSeparator,
  restoreFrontMatterSeparator,
} = compiledModule.exports

const lines = (...values) => values.join('\n')
const fixture = (name) =>
  fs.readFileSync(
    path.resolve(__dirname, '../test/front-matter', name),
    'utf8'
  )

/** Looks an entry up by key so assertions do not depend on declaration order. */
const at = (entries, key) => {
  const found = entries.find((entry) => entry.key === key)
  assert.ok(found, `expected an entry for "${key}"`)
  return found.value
}

const scalar = (value) => {
  assert.strictEqual(value.kind, 'scalar', 'expected a scalar value')
  return value
}

// --- findFrontMatter: the boundary rule, matched to VS Code -------------------

assert.strictEqual(
  findFrontMatter(lines('---', 'title: hello', '---', '', '# Body', '')).body,
  'title: hello',
  'the body excludes both marker lines'
)

assert.strictEqual(
  findFrontMatter(lines('---', 'title: hello', '---', '# Body')).raw,
  lines('---', 'title: hello', '---'),
  'raw covers the block including both markers and nothing after it'
)

assert.strictEqual(
  findFrontMatter(lines('# Heading', '', '---', 'title: hello', '---', '')),
  null,
  'a --- that is not the first line does not open front matter'
)

assert.strictEqual(
  findFrontMatter(lines('---', 'title: hello', '', '# Body', '')),
  null,
  'an unclosed block is not front matter, so it cannot swallow the document'
)

assert.strictEqual(
  findFrontMatter(lines('   ---', 'title: hello', '---', '')),
  null,
  'an indented opening marker does not count'
)

assert.strictEqual(
  findFrontMatter(lines('---', 'title: hello', '...', '# Body')).body,
  'title: hello',
  '... closes front matter as well as ---'
)

assert.strictEqual(
  findFrontMatter(lines('---', 'title: hello', '---  ', '# Body')).body,
  'title: hello',
  'trailing spaces on the closing marker are tolerated'
)

assert.strictEqual(
  findFrontMatter(lines('---', '---', '# Body')).body,
  '',
  'an empty block is still front matter'
)

// --- test01: the ordinary case -----------------------------------------------

{
  const block = findFrontMatter(fixture('test01.md'))
  assert.ok(block, 'test01 must be detected as front matter')
  const { entries, error } = parseFrontMatter(block.body)
  assert.strictEqual(error, null, 'test01 must parse cleanly')
  assert.deepStrictEqual(
    entries.map((entry) => entry.key),
    ['title', 'description', 'status', 'draft', 'priority'],
    'test01 keys must be reported in document order'
  )
  assert.strictEqual(
    scalar(at(entries, 'draft')).type,
    'boolean',
    'test01 draft: false is a boolean'
  )
  assert.strictEqual(
    scalar(at(entries, 'priority')).type,
    'number',
    'test01 priority: 1 is a number'
  )
  assert.ok(
    scalar(at(entries, 'title')).text.includes('Front Matter'),
    'a CJK value must survive parsing intact'
  )
}

// --- test02: nested maps and sequences ---------------------------------------

{
  const parsed = parseFrontMatter(
    lines(
      'title: Nested',
      'author:',
      '  name: Wu',
      '  contact:',
      '    email: wu@example.com',
      '    phone: "010-1234"',
      'items:',
      '  - first',
      '  - second',
      'records:',
      '  - name: alpha',
      '    score: 1',
      '  - name: beta',
      '    score: 2'
    )
  )
  assert.strictEqual(parsed.error, null, 'nested structures must parse cleanly')

  const author = at(parsed.entries, 'author')
  assert.strictEqual(author.kind, 'map', 'author must be a map')
  const contact = at(author.entries, 'contact')
  assert.strictEqual(contact.kind, 'map', 'author.contact must be a map')
  assert.strictEqual(
    scalar(at(contact.entries, 'email')).text,
    'wu@example.com',
    'a nested scalar must survive two levels of indentation'
  )
  assert.strictEqual(
    scalar(at(contact.entries, 'phone')).text,
    '010-1234',
    'quotes are stripped for display but the value is kept verbatim'
  )
  assert.strictEqual(
    scalar(at(contact.entries, 'phone')).type,
    'string',
    'a quoted digit string must stay a string, not become a number'
  )

  const items = at(parsed.entries, 'items')
  assert.strictEqual(items.kind, 'list', 'items must be a list')
  assert.deepStrictEqual(
    items.items.map((item) => scalar(item).text),
    ['first', 'second'],
    'sequence entries must keep their order'
  )

  const records = at(parsed.entries, 'records')
  assert.strictEqual(records.kind, 'list', 'records must be a list')
  assert.strictEqual(records.items.length, 2, 'records must have two items')
  assert.strictEqual(
    records.items[0].kind,
    'map',
    'a sequence item that starts with key: is a map'
  )
  assert.strictEqual(
    scalar(at(records.items[0].entries, 'name')).text,
    'alpha',
    'the mapping key on the dash line belongs to that item'
  )
  assert.strictEqual(
    scalar(at(records.items[0].entries, 'score')).text,
    '1',
    'continuation lines belong to the item the dash opened'
  )
  assert.strictEqual(
    scalar(at(records.items[1].entries, 'name')).text,
    'beta',
    'the second item must not absorb the first'
  )
}

// --- test03: scalar types must not be mistyped --------------------------------

{
  const parsed = parseFrontMatter(
    lines(
      'count: 42',
      'ratio: 3.14',
      'negative: -7',
      'exponent: 1e3',
      'enabled: true',
      'disabled: false',
      'nothing: null',
      'tilde: ~',
      'blank:',
      'when: 2026-08-10',
      'stamp: 2026-08-10T12:30:00Z',
      'version: 1.2.3',
      'quoted_number: "42"'
    )
  )
  assert.strictEqual(parsed.error, null, 'scalar fixtures must parse cleanly')

  const typeOf = (key) => scalar(at(parsed.entries, key)).type
  assert.strictEqual(typeOf('count'), 'number', 'an integer is a number')
  assert.strictEqual(typeOf('ratio'), 'number', 'a float is a number')
  assert.strictEqual(typeOf('negative'), 'number', 'a signed integer is a number')
  assert.strictEqual(typeOf('exponent'), 'number', 'exponent notation is a number')
  assert.strictEqual(typeOf('enabled'), 'boolean', 'true is a boolean')
  assert.strictEqual(typeOf('disabled'), 'boolean', 'false is a boolean')
  assert.strictEqual(typeOf('nothing'), 'null', 'null is null')
  assert.strictEqual(typeOf('tilde'), 'null', '~ is null')
  assert.strictEqual(typeOf('blank'), 'null', 'an empty value is null')
  assert.strictEqual(typeOf('when'), 'date', 'a plain date is a date')
  assert.strictEqual(typeOf('stamp'), 'date', 'a timestamp is a date')
  assert.strictEqual(
    typeOf('version'),
    'string',
    'a three-part version must not be read as a number'
  )
  assert.strictEqual(
    typeOf('quoted_number'),
    'string',
    'quoting forces a string even when the text looks numeric'
  )
  assert.strictEqual(
    scalar(at(parsed.entries, 'disabled')).text,
    'false',
    'false must keep its text so the table can show it'
  )
}

// --- test04: quoting, colons, hashes and block scalars ------------------------

{
  const parsed = parseFrontMatter(
    lines(
      'subtitle: "A title: with a colon"',
      'tag: "sharp # inside"',
      'single: \'it\'\'s quoted\'',
      'url: https://example.com/#anchor',
      'trailing: value # a real comment',
      'literal: |',
      '  first line',
      '    indented more',
      'folded: >',
      '  folded one',
      '  folded two',
      '',
      '  after a break'
    )
  )
  assert.strictEqual(parsed.error, null, 'quoting fixtures must parse cleanly')

  assert.strictEqual(
    scalar(at(parsed.entries, 'subtitle')).text,
    'A title: with a colon',
    'a colon inside quotes must not split the value'
  )
  assert.strictEqual(
    scalar(at(parsed.entries, 'tag')).text,
    'sharp # inside',
    'a hash inside quotes is not a comment'
  )
  assert.strictEqual(
    scalar(at(parsed.entries, 'single')).text,
    "it's quoted",
    "doubled single quotes unescape to one"
  )
  assert.strictEqual(
    scalar(at(parsed.entries, 'url')).text,
    'https://example.com/#anchor',
    'a hash with no leading space is part of the value'
  )
  assert.strictEqual(
    scalar(at(parsed.entries, 'trailing')).text,
    'value',
    'a hash after whitespace does open a comment'
  )
  assert.strictEqual(
    scalar(at(parsed.entries, 'literal')).text,
    lines('first line', '  indented more', ''),
    'a literal block keeps its own line breaks and relative indent'
  )
  assert.strictEqual(
    scalar(at(parsed.entries, 'folded')).text,
    lines('folded one folded two', '', 'after a break', ''),
    'a folded block joins lines with spaces and keeps blank-line breaks'
  )
}

// --- comments and blank lines between entries --------------------------------

{
  const parsed = parseFrontMatter(
    lines(
      '# leading comment',
      'title: hello',
      '',
      '# another comment',
      'draft: true'
    )
  )
  assert.strictEqual(parsed.error, null, 'comments must not break parsing')
  assert.strictEqual(
    parsed.entries.length,
    2,
    'comments and blank lines contribute no entries'
  )
  assert.strictEqual(
    scalar(at(parsed.entries, 'draft')).type,
    'boolean',
    'an entry after a comment is still parsed'
  )
}

// --- test07: invalid YAML reports an error instead of guessing ----------------

{
  const parsed = parseFrontMatter('title: [unclosed')
  assert.ok(
    parsed.error,
    'an unsupported flow collection must be reported, not half-read'
  )
  assert.deepStrictEqual(
    parsed.entries,
    [],
    'a failed parse yields no entries so the caller falls back to the source'
  )
}

{
  const parsed = parseFrontMatter(lines('title: hello', 'not a mapping line'))
  assert.ok(parsed.error, 'a line that is not key: value must be reported')
  assert.match(
    parsed.error,
    /2/,
    'the error must name the line it failed on'
  )
}

{
  const parsed = parseFrontMatter(lines('a: 1', '  b: 2', 'c: 3'))
  assert.ok(parsed.error, 'inconsistent indentation must be reported')
}

{
  const parsed = parseFrontMatter('anchor: &ref value')
  assert.ok(parsed.error, 'anchors are unsupported and must be reported')
  assert.match(parsed.error, /YAML/, 'the message must mention YAML')
}

// --- the remaining fixtures behave as their descriptions require -------------

{
  const block = findFrontMatter(fixture('test02.md'))
  const { entries, error } = parseFrontMatter(block.body)
  assert.strictEqual(error, null, 'test02 must parse cleanly')
  assert.deepStrictEqual(
    at(entries, 'tags').items.map((item) => scalar(item).text),
    ['markdown', 'vscode', 'compatibility'],
    'test02 tags must come through as a three-item list'
  )
  assert.strictEqual(
    scalar(
      at(at(at(entries, 'author').entries, 'contact').entries, 'email')
    ).text,
    'test@example.com',
    'test02 requires author.contact.email to resolve'
  )
  const items = at(entries, 'items')
  assert.strictEqual(items.items.length, 2, 'test02 items has two records')
  assert.strictEqual(
    scalar(at(items.items[1].entries, 'enabled')).text,
    'false',
    'test02 items[1].enabled must be the false belonging to the second record'
  )
}

{
  const block = findFrontMatter(fixture('test03.md'))
  const { entries, error } = parseFrontMatter(block.body)
  assert.strictEqual(error, null, 'test03 must parse cleanly')
  const typeOf = (key) => scalar(at(entries, key)).type
  assert.strictEqual(typeOf('integerValue'), 'number', 'test03 integer')
  assert.strictEqual(typeOf('floatValue'), 'number', 'test03 float')
  assert.strictEqual(typeOf('booleanTrue'), 'boolean', 'test03 true')
  assert.strictEqual(typeOf('booleanFalse'), 'boolean', 'test03 false')
  assert.strictEqual(typeOf('nullValue'), 'null', 'test03 null')
  assert.strictEqual(typeOf('dateValue'), 'date', 'test03 date')
  assert.strictEqual(typeOf('emptyValue'), 'null', 'test03 empty value')
}

{
  const block = findFrontMatter(fixture('test04.md'))
  const { entries, error } = parseFrontMatter(block.body)
  assert.strictEqual(error, null, 'test04 must parse cleanly')
  assert.strictEqual(
    scalar(at(entries, 'quotedColon')).text,
    'value: contains a colon',
    'test04 requires a quoted colon to stay in the value'
  )
  assert.strictEqual(
    scalar(at(entries, 'quotedHash')).text,
    'value # is not a comment',
    'test04 requires a quoted hash not to be read as a comment'
  )
  assert.ok(
    scalar(at(entries, 'literalText')).text.includes('\n'),
    'test04 literal block must keep its line break'
  )
  assert.ok(
    !scalar(at(entries, 'foldedText')).text.trimEnd().includes('\n'),
    'test04 folded block must fold its single break into a space'
  )
}

{
  const block = findFrontMatter(fixture('test07.md'))
  assert.ok(block, 'test07 opens with --- so the block is detected')
  const parsed = parseFrontMatter(block.body)
  assert.ok(
    parsed.error,
    'test07 contains invalid YAML, so an error must be reported'
  )
}

{
  assert.strictEqual(
    findFrontMatter(fixture('test08.md')),
    null,
    'test08 never closes its block, so nothing may be treated as front matter'
  )
}

{
  const source = fixture('test11.md')
  const block = findFrontMatter(source)
  assert.ok(block, 'test11 must be detected as front matter')
  assert.ok(
    !block.body.includes('#'),
    'test11 must close at its own marker, not at the later horizontal rule'
  )
  assert.strictEqual(
    parseFrontMatter(block.body).error,
    null,
    'test11 must parse cleanly'
  )
  assert.ok(
    source.slice(block.end).includes('---'),
    'the horizontal rule after the block stays in the document body'
  )
}

{
  assert.strictEqual(
    findFrontMatter(fixture('test09.md')),
    null,
    'test09 has a comment before ---, so there is no front matter'
  )
  assert.strictEqual(
    findFrontMatter(fixture('test10.md')),
    null,
    'test10 indents ---, so there is no front matter'
  )
}

// --- the separator the parser would otherwise delete --------------------------

{
  assert.strictEqual(
    frontMatterSeparator(lines('---', 'title: x', '---', '', '# Body', '')),
    '\n\n',
    'a blank line between the block and the body is reported'
  )
  assert.strictEqual(
    frontMatterSeparator(lines('---', 'title: x', '---', '# Body', '')),
    '\n',
    'no blank line is reported as the single newline that is there'
  )
  assert.strictEqual(
    frontMatterSeparator(lines('---', 'title: x', '---', '')),
    null,
    'a document that is only front matter has no separator to preserve'
  )
  assert.strictEqual(
    frontMatterSeparator(lines('# Body', '', 'text', '')),
    null,
    'a document without front matter has no separator'
  )
  assert.strictEqual(
    frontMatterSeparator(lines('---', 'title: x', '---', '', '', '# Body', '')),
    '\n\n\n',
    'two blank lines are preserved as written, not collapsed to one'
  )
}

{
  const collapsed = lines('---', 'title: x', '---', '# Body', '')
  assert.strictEqual(
    restoreFrontMatterSeparator(collapsed, '\n\n'),
    lines('---', 'title: x', '---', '', '# Body', ''),
    'the remembered blank line is put back'
  )
  assert.strictEqual(
    restoreFrontMatterSeparator(collapsed, null),
    collapsed,
    'with nothing remembered the text is returned untouched'
  )
  assert.strictEqual(
    restoreFrontMatterSeparator(collapsed, '\n'),
    collapsed,
    'restoring the separator that is already there changes nothing'
  )
  assert.strictEqual(
    restoreFrontMatterSeparator(lines('# Body', '', 'text', ''), '\n\n'),
    lines('# Body', '', 'text', ''),
    'a document without front matter is never rewritten'
  )
  assert.strictEqual(
    restoreFrontMatterSeparator(lines('---', 'title: x', '---', ''), '\n\n'),
    lines('---', 'title: x', '---', ''),
    'a document with no body is left alone rather than given a blank line'
  )
  // The round trip has to be stable: applying the repair to already-repaired
  // text must not keep adding newlines.
  const repaired = restoreFrontMatterSeparator(collapsed, '\n\n')
  assert.strictEqual(
    restoreFrontMatterSeparator(repaired, '\n\n'),
    repaired,
    'the repair is idempotent'
  )
  assert.strictEqual(
    restoreFrontMatterSeparator(
      lines('---', 'title: edited', 'added: 1', '---', '# Body', ''),
      '\n\n'
    ),
    lines('---', 'title: edited', 'added: 1', '---', '', '# Body', ''),
    'the separator is restored even after the block itself was edited'
  )
}

{
  // Round trip across a real fixture: capture, collapse the way the parser does,
  // then restore, and the document must come back exactly as it started.
  const source = fixture('test01.md')
  const separator = frontMatterSeparator(source)
  const block = findFrontMatter(source)
  const collapsed =
    source.slice(0, block.end) + '\n' + source.slice(block.end + separator.length)
  assert.notStrictEqual(collapsed, source, 'the collapse must actually change something')
  assert.strictEqual(
    restoreFrontMatterSeparator(collapsed, separator),
    source,
    'test01 must survive a collapse and restore byte for byte'
  )
}

// --- an empty block parses to nothing without erroring ------------------------

{
  const parsed = parseFrontMatter('')
  assert.strictEqual(parsed.error, null, 'an empty body is not an error')
  assert.deepStrictEqual(parsed.entries, [], 'an empty body has no entries')
}

console.log('front matter parser tests passed')
