const assert = require('assert')
const { existsSync, readFileSync, readdirSync } = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (relativePath) =>
  readFileSync(path.join(root, relativePath), 'utf8')

const mainJs = read('media/dist/main.js')
const mainCss = read('media/dist/main.css')
const luteJs = read('media/dist/lute.min.js')
const vendoredLuteJs = read('vendor/lute/lute.min.js')
const luteLicense = read('media/dist/lute.LICENSE.txt')
const vendoredLuteLicense = read('vendor/lute/LICENSE')
const sourceMap = JSON.parse(read('media/dist/main.js.map'))
const bundledText = `${mainJs}\n${mainCss}\n${luteJs}`

const removedRuntimeSignatures = [
  '.vditor-ir',
  '--ir-',
  ['instant', 'Rendering'].join(''),
  ['Md2Vditor', 'IRDOM'].join(''),
  ['HTML2Vditor', 'IRDOM'].join(''),
  ['SpinVditor', 'IRDOM'].join(''),
  ['Vditor', 'IRDOM2Md'].join(''),
  ['SetVditor', 'IR'].join(''),
]
for (const signature of removedRuntimeSignatures) {
  assert.ok(
    !bundledText.includes(signature),
    `two-mode bundle still contains removed runtime signature: ${signature}`
  )
}
assert.strictEqual(
  luteJs,
  vendoredLuteJs,
  'media/dist does not contain the reviewed two-mode Lute build'
)
assert.strictEqual(
  luteLicense,
  vendoredLuteLicense,
  'media/dist does not contain the upstream Lute license'
)
require(path.join(root, 'vendor/lute/lute.min.js'))
const lute = global.Lute.New()
for (const api of [
  'Md2VditorDOM',
  'VditorDOM2Md',
  'HTML2VditorDOM',
  'SpinVditorDOM',
  'Md2VditorSVDOM',
  'SpinVditorSVDOM',
  'SetVditorWYSIWYG',
  'SetVditorSV',
]) {
  assert.strictEqual(typeof lute[api], 'function', `two-mode Lute is missing ${api}`)
}

const bundledSources = sourceMap.sources.map((source) =>
  source.replace(/\\/g, '/').toLowerCase()
)
assert.ok(
  !bundledSources.some((source) => source.includes('/vditor/src/ts/ir/')),
  'two-mode bundle still includes a removed Vditor editor source module'
)
assert.ok(
  bundledSources.some((source) => source.endsWith('/vditor/src/index.ts')),
  'webview did not bundle the patched Vditor TypeScript entry'
)
assert.match(mainCss, /\.vditor-wysiwyg\b/, 'WYSIWYG styles are missing')
assert.match(mainCss, /\.vditor-sv\b/, 'split-view styles are missing')

const patchedEditorDirectory = path.join(
  root,
  'media-src/node_modules/vditor/src/ts/ir'
)
assert.deepStrictEqual(
  existsSync(patchedEditorDirectory) ? readdirSync(patchedEditorDirectory) : [],
  [],
  'patched Vditor package still contains removed editor source files'
)

const patchedSourceRoot = path.join(root, 'media-src/node_modules/vditor/src')
const sourceFiles = []
const collectSourceFiles = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) collectSourceFiles(fullPath)
    else if (/\.(?:ts|less)$/.test(entry.name)) sourceFiles.push(fullPath)
  }
}
collectSourceFiles(patchedSourceRoot)
const patchedSource = sourceFiles
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n')
for (const signature of removedRuntimeSignatures) {
  assert.ok(
    !patchedSource.includes(signature),
    `patched Vditor source still contains removed runtime signature: ${signature}`
  )
}

console.log('two-mode bundle tests passed')
