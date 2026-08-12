const assert = require('assert')
const { readFileSync } = require('fs')
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
  assert.deepStrictEqual(
    packageJson.contributes.customEditors.map((editor) => editor.viewType),
    ['markdown-interactor.customEditor'],
    'more than one editor entry is contributed'
  )
  assert.ok(disposables.length >= 3, 'activation did not retain its disposables')
}

testSingleCustomEditorEntry()
  .then(() => console.log('single custom editor tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
