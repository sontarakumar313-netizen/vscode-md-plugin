const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function declarationsFor(css, selector, relativePath) {
  const marker = `${selector} {`
  const start = css.indexOf(marker)
  assert.notStrictEqual(start, -1, `${relativePath} is missing ${selector}`)
  assert.strictEqual(
    css.indexOf(marker, start + marker.length),
    -1,
    `${relativePath} defines ${selector} more than once`
  )
  const end = css.indexOf('}', start + marker.length)
  assert.notStrictEqual(end, -1, `${relativePath} has an incomplete ${selector} rule`)
  return css.slice(start + marker.length, end)
}

const centeredImageSelector = '#app.vditor .vditor-reset img:not(.emoji)'
for (const relativePath of [
  'media/markdown-interactor.default.css',
  '00-styles/dark-graphite-ember.css',
  '00-styles/dark-midnight-neon.css',
  '00-styles/light-paper-day.css',
]) {
  const declarations = declarationsFor(
    read(relativePath),
    centeredImageSelector,
    relativePath
  )
  assert.match(declarations, /\bdisplay\s*:\s*block\s*;/)
  assert.match(declarations, /\bmargin-inline\s*:\s*auto\s*;/)
}

const mainCssPath = 'media-src/src/main.css'
const mainCss = read(mainCssPath)
const mermaidSvgSelector =
  '#app.vditor .vditor-reset .language-mermaid > svg'
const mermaidDeclarations = declarationsFor(
  mainCss,
  mermaidSvgSelector,
  mainCssPath
)
assert.match(mermaidDeclarations, /\bdisplay\s*:\s*block\s*;/)
assert.match(mermaidDeclarations, /\bmargin-inline\s*:\s*auto\s*;/)
assert.doesNotMatch(
  mermaidDeclarations,
  /\bmargin-(?:top|bottom)\s*:/,
  'the Mermaid baseline fix must not remove normal vertical block spacing'
)

console.log('theme media CSS tests passed')
