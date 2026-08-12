const assert = require('assert')
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

function disposable() {
  return { dispose() {} }
}

const vscode = {
  ColorThemeKind: {
    Dark: 2,
    HighContrast: 3,
  },
  Uri: {
    file: makeUri,
    joinPath(base, ...segments) {
      return makeUri(path.join(base.fsPath, ...segments))
    },
  },
  window: {
    activeColorTheme: { kind: 1 },
    onDidChangeActiveColorTheme: () => disposable(),
  },
  workspace: {
    workspaceFolders: undefined,
    getWorkspaceFolder: () => undefined,
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeTextDocument: () => disposable(),
  },
}

const sourcePath = path.resolve(
  __dirname,
  '../src/custom-editor-provider.ts'
)
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

const { MarkdownEditorProvider } = compiledModule.exports
let receiveMessage
const postedMessages = []
const webview = {
  cspSource: 'vscode-webview://test',
  asWebviewUri(uri) {
    return uri
  },
  onDidReceiveMessage(listener) {
    receiveMessage = listener
    return disposable()
  },
  postMessage(message) {
    postedMessages.push(message)
    return Promise.resolve(true)
  },
  set options(value) {
    this._options = value
  },
  get options() {
    return this._options
  },
  set html(value) {
    this._html = value
    assert.strictEqual(
      typeof receiveMessage,
      'function',
      'the ready listener must exist before assigning webview HTML'
    )
    receiveMessage({ command: 'ready' })
  },
  get html() {
    return this._html
  },
}

const markdownUri = makeUri('C:/workspace/example.md')
const document = {
  uri: markdownUri,
  version: 1,
  getText: () => '# Example',
}
const panel = {
  webview,
  onDidDispose: () => disposable(),
  title: '',
}
const context = {
  extensionUri: makeUri('C:/extension'),
  globalState: { get: () => ({}) },
}

async function testInitialReadyMessage() {
  const provider = new MarkdownEditorProvider(context)
  await provider.resolveCustomTextEditor(document, panel, {})
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.ok(webview.html.includes('media/dist/main.js'))
  assert.ok(
    webview.html.includes('img-src vscode-webview://test https: data: blob:'),
    'remote media must remain enabled by default for compatibility'
  )
  assert.deepStrictEqual(postedMessages, [
    {
      command: 'update',
      content: '# Example',
      documentVersion: 1,
      editorGeneration: 1,
      scrollTop: 0,
      type: 'init',
      // The stub configuration returns undefined for every key, so these are
      // the host fallbacks for unset or hand-edited values.
      options: {
        useVscodeThemeColor: undefined,
        mode: 'wysiwyg',
        frontMatterDisplay: 'table',
      },
      theme: 'light',
      workspaceStyleCss: null,
      workspaceStylePath: null,
    },
  ])
}

testInitialReadyMessage()
  .then(() => console.log('custom editor startup tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
