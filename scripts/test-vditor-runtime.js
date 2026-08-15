const assert = require('assert')
const { existsSync, readFileSync } = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (relativePath) =>
  readFileSync(path.join(root, relativePath), 'utf8')

const mainCss = read('media/dist/main.css')
const bundledLute = read('media/dist/lute.min.js')
const officialLute = read(
  'media-src/node_modules/vditor/dist/js/lute/lute.min.js'
)
const bundledLicense = read('media/dist/lute.LICENSE.txt')
const upstreamLicense = read('media-src/vendor/lute.LICENSE.txt')
const sourceMap = JSON.parse(read('media/dist/main.js.map'))

assert.strictEqual(
  existsSync(path.join(root, 'media/dist/emoji')),
  false,
  'emoji assets must not be emitted into media/dist'
)

assert.strictEqual(
  bundledLute,
  officialLute,
  'media/dist must contain the Lute build from the pinned official Vditor package'
)
assert.strictEqual(
  bundledLicense,
  upstreamLicense,
  'media/dist does not contain the upstream Lute license'
)

require(path.join(root, 'media/dist/lute.min.js'))
const lute = global.Lute.New()
for (const api of [
  'Md2VditorDOM',
  'VditorDOM2Md',
  'Md2VditorIRDOM',
  'VditorIRDOM2Md',
  'Md2VditorSVDOM',
  'SetVditorWYSIWYG',
  'SetVditorIR',
  'SetVditorSV',
]) {
  assert.strictEqual(
    typeof lute[api],
    'function',
    `the official Lute runtime is missing ${api}`
  )
}

const bundledSources = sourceMap.sources.map((source) =>
  source.replace(/\\/g, '/').toLowerCase()
)
assert.ok(
  bundledSources.some((source) => source.endsWith('/vditor/src/index.ts')),
  'webview did not bundle the pinned official Vditor source entry'
)
assert.ok(
  bundledSources.some((source) => source.includes('/vditor/src/ts/ir/')),
  'the official Vditor runtime was physically stripped of IR mode'
)
const setLuteSourceIndex = bundledSources.findIndex((source) =>
  source.endsWith('/vditor/src/ts/markdown/setlute.ts')
)
assert.ok(setLuteSourceIndex >= 0, 'the bundled Lute setup source is missing')
assert.match(
  sourceMap.sourcesContent[setLuteSourceIndex],
  /lute\.SetEmojis\(\{\}\)/,
  'the bundled editor did not disable emoji shortcodes'
)
assert.match(
  mainCss,
  /\.vditor-ir\b/,
  'the official Vditor styles were physically stripped of IR mode'
)
assert.match(mainCss, /\.vditor-wysiwyg\b/, 'WYSIWYG styles are missing')
assert.match(mainCss, /\.vditor-sv\b/, 'split-view styles are missing')

console.log('official Vditor runtime tests passed')
