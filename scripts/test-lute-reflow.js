const assert = require('assert')
const path = require('path')
const { reconcileCanonicalisedEdit } = require('../out/text-sync')

const lutePath = path.resolve(
  __dirname,
  '../media-src/node_modules/vditor/dist/js/lute/lute.min.js'
)
require(lutePath)
assert.strictEqual(
  typeof global.Lute?.New,
  'function',
  `Bundled Lute no longer exposes global.Lute.New: ${lutePath}`
)
const lute = global.Lute.New()
const round = (markdown) =>
  lute.VditorDOM2Md(lute.Md2VditorDOM(markdown))

const fixtures = [
  {
    name: 'table alignment padding',
    origin: '| a | longer |\n| - | - |\n| 1 | 2 |\n\nsentinel old\n',
  },
  {
    name: 'task marker case and spacing',
    origin: '* [x] done\n\nsentinel old\n',
  },
  {
    name: 'consecutive blank lines',
    origin: 'alpha\n\n\n\nbeta\n\nsentinel old\n',
  },
  {
    name: 'mixed unordered-list markers',
    origin: '+ plus\n* star\n- dash\n\nsentinel old\n',
  },
  {
    name: 'hard break trailing spaces',
    origin: 'hard break  \nnext\n\nsentinel old\n',
  },
  {
    name: 'four-space nested list',
    origin: '- parent\n    - child\n\nsentinel old\n',
  },
  {
    name: 'indented code block',
    origin: '    const value = 1\n\n# sentinel old\n',
  },
  {
    name: 'fenced-code info string',
    origin: '```js title="x"\nconst x = 1\n```\n\nsentinel old\n',
  },
  {
    name: 'thematic break marker',
    origin: 'alpha\n\n***\n\nbeta\n\nsentinel old\n',
  },
  {
    name: 'reference-link title and spacing',
    origin:
      '[ref]: https://example.com "Title"\n\nUse [ref].\n\nsentinel old\n',
  },
  {
    name: 'bare URL',
    origin: 'https://example.com\n\nsentinel old\n',
  },
  {
    name: 'lazy blockquote continuation',
    origin: '> quoted\nlazy continuation\n\nsentinel old\n',
  },
  {
    name: 'paragraph trailing space',
    origin: 'paragraph \nnext\n\nsentinel old\n',
  },
  {
    name: 'loose list spacing',
    origin: '- one\n\n- two\n\nsentinel old\n',
  },
  {
    name: 'closing heading markers',
    origin: '## Heading ##\n\nsentinel old\n',
  },
  {
    name: 'ordered-list numbering',
    origin: '1. one\n1. two\n1. three\n\nsentinel old\n',
  },
]

for (const fixture of fixtures) {
  const baseline = round(fixture.origin)
  assert.notStrictEqual(
    baseline,
    fixture.origin,
    `${fixture.name}: fixture no longer demonstrates Lute reflow`
  )
  if (fixture.nonIdempotent) {
    assert.notStrictEqual(
      round(baseline),
      baseline,
      `${fixture.name}: fixture no longer demonstrates non-idempotent projection`
    )
  }

  assert.ok(
    baseline.includes('sentinel old'),
    `${fixture.name}: Lute removed the unrelated edit sentinel`
  )
  const local = baseline.replace('sentinel old', 'sentinel new')
  const reconciled = reconcileCanonicalisedEdit(
    fixture.origin,
    baseline,
    local
  )
  const expected = fixture.origin.replace('sentinel old', 'sentinel new')

  assert.strictEqual(
    reconciled,
    expected,
    `${fixture.name}: untouched source formatting drifted`
  )
  assert.strictEqual(
    round(reconciled),
    local,
    `${fixture.name}: reconciled source no longer represents the editor view`
  )
}

console.log(`Lute reflow reconciliation tests passed (${fixtures.length} fixtures)`)
