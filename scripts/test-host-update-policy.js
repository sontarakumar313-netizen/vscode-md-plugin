const assert = require('assert')
const Module = require('module')
const path = require('path')
const { buildSync } = require('esbuild')

const sourcePath = path.resolve(
  __dirname,
  '../media-src/src/host-update-policy.ts'
)
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
  canApplyHostUpdate,
  keepNewestHostUpdate,
} = compiledModule.exports

assert.strictEqual(
  canApplyHostUpdate({
    isComposing: false,
    pendingEditCount: 0,
  }),
  true,
  'focus is no longer part of the host-update safety boundary'
)
assert.strictEqual(
  canApplyHostUpdate({
    isComposing: true,
    pendingEditCount: 0,
  }),
  false,
  'IME composition must defer a host update'
)
assert.strictEqual(
  canApplyHostUpdate({
    isComposing: false,
    pendingEditCount: 1,
  }),
  false,
  'posted edits must settle before a host update is applied'
)
assert.strictEqual(
  canApplyHostUpdate({ isComposing: false, pendingEditCount: 2 }),
  false,
  'every pending edit must settle before a host update is applied'
)

const older = { content: 'older', documentVersion: 2 }
const newer = { content: 'newer', documentVersion: 3 }
assert.strictEqual(keepNewestHostUpdate(null, older), older)
assert.strictEqual(keepNewestHostUpdate(older, newer), newer)
assert.strictEqual(keepNewestHostUpdate(newer, older), newer)

console.log('host update policy tests passed')
