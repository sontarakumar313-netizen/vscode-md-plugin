const assert = require('assert')
const { execFileSync } = require('child_process')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs')
const Module = require('module')
const path = require('path')
const { buildSync } = require('esbuild')

function makeUri(fsPath) {
  return {
    fsPath,
    toString() {
      return `file://${fsPath.replace(/\\/g, '/')}`
    },
  }
}

const disposables = []
const commands = new Map()
const executedCommands = []
const registeredProviders = []
const markdownUri = makeUri('C:/workspace/example.md')
const markdownDocument = {
  uri: markdownUri,
  languageId: 'markdown',
}
const vscode = {
  commands: {
    registerCommand(name, callback) {
      commands.set(name, callback)
      return { dispose() {} }
    },
    executeCommand(...args) {
      executedCommands.push(args)
      return Promise.resolve()
    },
  },
  window: {
    activeTextEditor: { document: markdownDocument },
    registerCustomEditorProvider(viewType, provider) {
      registeredProviders.push({ viewType, provider })
      return { dispose() {} }
    },
    showErrorMessage() {
      return Promise.resolve(undefined)
    },
  },
  workspace: {
    openTextDocument(uri) {
      assert.strictEqual(uri, markdownUri)
      return Promise.resolve(markdownDocument)
    },
  },
}

const projectRoot = path.resolve(__dirname, '..')
const staleOutput = path.join(projectRoot, 'out', 'editor-panel.js')
mkdirSync(path.dirname(staleOutput), { recursive: true })
writeFileSync(staleOutput, '// stale Custom Editor build artifact\n')
execFileSync(
  process.platform === 'win32' ? 'cmd.exe' : 'npm',
  process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm run build:extension']
    : ['run', 'build:extension'],
  {
    cwd: projectRoot,
    stdio: 'pipe',
  }
)
assert.ok(
  !existsSync(staleOutput),
  'build:extension did not remove an output whose TypeScript source was deleted'
)

const sourcePath = path.resolve(__dirname, '../src/extension.ts')
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

const context = {
  subscriptions: {
    push(...items) {
      disposables.push(...items)
    },
  },
  globalState: {
    setKeysForSync(keys) {
      assert.deepStrictEqual(keys, ['vditor.options'])
    },
  },
}

async function testSingleCustomEditorEntry() {
  compiledModule.exports.activate(context)

  assert.deepStrictEqual(
    registeredProviders.map(({ viewType }) => viewType),
    ['markdown-interactor.customEditor'],
    'activation did not register exactly one Custom Editor provider'
  )
  const openEditor = commands.get('markdown-interactor.openEditor')
  assert.strictEqual(typeof openEditor, 'function', 'open command was not registered')

  await openEditor()
  assert.deepStrictEqual(executedCommands, [
    ['vscode.openWith', markdownUri, 'markdown-interactor.customEditor'],
  ])

  const packageJson = JSON.parse(
    readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')
  )
  assert.ok(
    !packageJson.activationEvents.includes('onWebviewPanel:markdown-interactor'),
    'the legacy WebviewPanel activation event is still contributed'
  )
  const editors = packageJson.contributes.customEditors
  assert.deepStrictEqual(
    editors.map((editor) => editor.viewType),
    ['markdown-interactor.customEditor'],
    'the manifest contributed more than one Custom Editor'
  )
  assert.deepStrictEqual(
    editors.map((editor) => editor.displayName),
    ['Markdown Interactor Editor'],
    'the Custom Editor display name is incorrect'
  )
  assert.deepStrictEqual(
    editors[0].selector,
    [{ filenamePattern: '*.{md,markdown}' }],
    'the editor must use the shared Markdown selector registration'
  )
  assert.strictEqual(
    editors[0].priority,
    'default',
    'the single Markdown Interactor editor must remain the default choice'
  )
  assert.ok(
    packageJson.activationEvents.includes(
      'onCustomEditor:markdown-interactor.customEditor'
    ) &&
      !packageJson.activationEvents.includes(
        'onCustomEditor:markdown-interactor.splitEditor'
      ),
    'activation events still expose the removed Split View editor type'
  )
  assert.ok(disposables.length >= 3, 'activation did not retain its disposables')
}

testSingleCustomEditorEntry()
  .then(() => console.log('single custom editor tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
