const assert = require('assert')
const Module = require('module')
const path = require('path')
const { buildSync } = require('esbuild')

const sourcePath = path.resolve(__dirname, '../media-src/src/math-delimiters.ts')
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

const { LatexMathCompatibility } = compiledModule.exports
const paren = (content) => `\\(${content}\\)`
const bracket = (content) => `\\[${content}\\]`

const source =
  `Inline ${paren('x^2')}, display ${bracket('y^2')}, ` +
  'native $z$ and $$w$$.'
const normalized = 'Inline $x^2$, display $$y^2$$, native $z$ and $$w$$.'
const compatibility = new LatexMathCompatibility()
assert.strictEqual(compatibility.prepare(source), normalized)

let storedValue = normalized
const editor = {
  getValue: () => storedValue,
  setValue: (value) => {
    storedValue = value
  },
}
compatibility.attach(editor)
assert.strictEqual(editor.getValue(), source)

storedValue = storedValue.replace('x^2', 'x^3').replace('y^2', 'y^3')
assert.strictEqual(
  editor.getValue(),
  `Inline ${paren('x^3')}, display ${bracket('y^3')}, native $z$ and $$w$$.`
)

const replacementSource = `New ${paren('inline')} and ${bracket('display')}`
editor.setValue(replacementSource)
assert.strictEqual(storedValue, 'New $inline$ and $$display$$')
assert.strictEqual(editor.getValue(), replacementSource)

// Identical formulas using different delimiter styles retain their own style.
const duplicateCompatibility = new LatexMathCompatibility()
const duplicateSource = `${paren('x')} / $x$ / ${bracket('y')} / $$y$$`
let duplicateStored = duplicateCompatibility.prepare(duplicateSource)
const duplicateEditor = {
  getValue: () => duplicateStored,
  setValue: (value) => {
    duplicateStored = value
  },
}
duplicateCompatibility.attach(duplicateEditor)
assert.strictEqual(duplicateEditor.getValue(), duplicateSource)

// Delimiters in code, raw code elements, and escaped text are literal text.
const protectedCompatibility = new LatexMathCompatibility()
const protectedSource = [
  `inline code: \`${paren('code')}\``,
  '```tex',
  paren('fenced'),
  '```',
  `raw: <code>${paren('raw')}</code>`,
  'escaped: \\\\(literal\\\\)',
  `actual: ${paren('rendered')}`,
].join('\n')
const protectedPrepared = protectedCompatibility.prepare(protectedSource)
assert.ok(protectedPrepared.includes(`\`${paren('code')}\``))
assert.ok(protectedPrepared.includes(paren('fenced')))
assert.ok(protectedPrepared.includes(`<code>${paren('raw')}</code>`))
assert.ok(protectedPrepared.includes('\\\\(literal\\\\)'))
assert.ok(protectedPrepared.includes('actual: $rendered$'))

console.log('math delimiter tests passed')
