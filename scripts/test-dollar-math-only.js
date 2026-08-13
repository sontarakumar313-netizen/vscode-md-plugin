const assert = require('assert')
const { readFileSync } = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const mainSource = readFileSync(
  path.join(root, 'media-src/src/main.ts'),
  'utf8'
)

assert.ok(
  !mainSource.includes('LatexMathCompatibility') &&
    !mainSource.includes("'./math-delimiters'"),
  'the webview still installs alternate math delimiter compatibility'
)

const configuredMathEngine = mainSource.match(
  /engine:\s*['"]([^'"]+)['"]/
)?.[1]
assert.strictEqual(
  configuredMathEngine,
  'KaTeX',
  'formula documents must use the non-blocking KaTeX initialization path'
)

require(path.join(root, 'media-src/node_modules/vditor/dist/js/lute/lute.min.js'))
const lute = global.Lute.New()
lute.SetVditorWYSIWYG(true)

const dollarMarkdown = 'Inline $x^2$ and display:\n\n$$\ny^2\n$$'
const dollarDom = lute.Md2VditorDOM(dollarMarkdown)
assert.match(dollarDom, /data-type="math-inline"/)
assert.match(dollarDom, /data-type="math-block"/)

const alternateMarkdown = 'Literal \\(x^2\\) and \\[y^2\\]'
const alternateDom = lute.Md2VditorDOM(alternateMarkdown)
assert.ok(
  !/data-type="(?:math-inline|math-block)"/.test(alternateDom),
  'alternate bracket delimiters still render as formulas'
)

console.log('dollar-only math tests passed')
