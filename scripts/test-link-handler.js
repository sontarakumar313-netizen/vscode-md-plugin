const assert = require('assert')
const Module = require('module')
const path = require('path')
const { buildSync } = require('esbuild')

function makeUri(fsPath, options = {}) {
  const scheme = options.scheme || 'file'
  const raw = options.raw || `${scheme}://${fsPath.replace(/\\/g, '/')}`
  return {
    fsPath,
    scheme,
    query: options.query || '',
    fragment: options.fragment || '',
    toString() {
      return raw
    },
    with(changes) {
      return makeUri(fsPath, {
        scheme,
        raw,
        query: changes.query === undefined ? this.query : changes.query,
        fragment: changes.fragment === undefined ? this.fragment : changes.fragment,
      })
    },
  }
}

const openedExternal = []
const executedCommands = []
const vscode = {
  FileType: { File: 1, Directory: 2 },
  Uri: {
    file: (fsPath) => makeUri(fsPath),
    parse: (value) => {
      const scheme = value.slice(0, value.indexOf(':')).toLowerCase()
      return makeUri(value, { scheme, raw: value })
    },
  },
  env: {
    openExternal: async (uri) => {
      openedExternal.push(uri.toString())
      return true
    },
  },
  workspace: {
    fs: {
      stat: async () => ({ type: 1 }),
    },
  },
  commands: {
    executeCommand: async (...args) => {
      executedCommands.push(args)
    },
  },
}

const sourcePath = path.resolve(__dirname, '../src/link-handler.ts')
const compiledSource = buildSync({
  entryPoints: [sourcePath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  write: false,
}).outputFiles[0].text

const originalLoad = Module._load
const compiledModule = new Module(sourcePath)
compiledModule.filename = sourcePath
compiledModule.paths = module.paths
try {
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode
    return originalLoad.call(this, request, parent, isMain)
  }
  compiledModule._compile(compiledSource, sourcePath)
} finally {
  Module._load = originalLoad
}

const { isAllowedExternalUriScheme, openMarkdownLink } = compiledModule.exports
const markdownUri = makeUri('C:/workspace/example.md')

async function main() {
  assert.strictEqual(isAllowedExternalUriScheme('https'), true)
  assert.strictEqual(isAllowedExternalUriScheme('MAILTO'), true)
  assert.strictEqual(isAllowedExternalUriScheme('vscode'), false)

  await openMarkdownLink(markdownUri, 'https://example.com/docs')
  await openMarkdownLink(markdownUri, 'mailto:test@example.com')
  assert.deepStrictEqual(openedExternal, [
    'https://example.com/docs',
    'mailto:test@example.com',
  ])

  for (const unsafeTarget of [
    'command:workbench.action.files.openFile',
    'vscode://settings/editor.fontSize',
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'ftp://example.com/file',
  ]) {
    await openMarkdownLink(markdownUri, unsafeTarget)
  }
  assert.strictEqual(
    openedExternal.length,
    2,
    'unapproved URI schemes from Markdown must not reach the operating system'
  )

  await openMarkdownLink(markdownUri, 'relative-note.md#section')
  assert.deepStrictEqual(
    executedCommands.map((call) => call[0]),
    ['vscode.open'],
    'relative Markdown file links must retain their existing open behavior'
  )

  console.log('link handling tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
