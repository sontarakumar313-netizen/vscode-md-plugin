const assert = require('assert')
const path = require('path')
const { buildSync } = require('esbuild')

const sourcePath = path.resolve(
  __dirname,
  '../media-src/src/upload-timestamp.ts'
)
const compiledSource = buildSync({
  entryPoints: [sourcePath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
}).outputFiles[0].text
const compiledModule = { exports: {} }
new Function('module', 'exports', compiledSource)(
  compiledModule,
  compiledModule.exports
)
const { formatUploadTimestamp } = compiledModule.exports

assert.strictEqual(
  formatUploadTimestamp(new Date(2026, 0, 2, 3, 4, 5, 6)),
  '20260102_030405_006'
)
assert.strictEqual(
  formatUploadTimestamp(new Date(2031, 10, 12, 13, 14, 15, 987)),
  '20311112_131415_987'
)

console.log('upload timestamp tests passed')
