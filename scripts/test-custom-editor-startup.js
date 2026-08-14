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

let configurationListener
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
    onDidChangeConfiguration: (listener) => {
      configurationListener = listener
      return disposable()
    },
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
const markdownUri = makeUri('C:/workspace/example.md')
const document = {
  uri: markdownUri,
  version: 1,
  getText: () => '# Example',
}

async function openEditor(savedMode, expectedMode) {
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
  const panel = {
    webview,
    onDidDispose: () => disposable(),
    title: '',
  }
  const context = {
    extensionUri: makeUri('C:/extension'),
    globalState: { get: () => ({ mode: savedMode }) },
  }

  const provider = new MarkdownEditorProvider(context)
  await provider.resolveCustomTextEditor(document, panel, {})
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.ok(webview.html.includes('media/dist/main.js'))
  assert.strictEqual(
    webview.options.enableFindWidget,
    true,
    'the Custom Editor must delegate Ctrl/Cmd+F to VS Code Find Widget'
  )
  assert.ok(
    webview.html.includes('img-src vscode-webview://test https: data: blob:'),
    'remote media must remain enabled by default for compatibility'
  )
  assert.strictEqual(
    postedMessages[0]?.options?.toolbarShortcuts?.save,
    'Mod+S',
    'initialization did not include validated toolbar shortcuts'
  )
  const postedMessagesWithoutFrontMatter = postedMessages.map((message) => {
    if (!message.options) return message
    const { frontMatterDisplay: _frontMatterDisplay, ...options } = message.options
    return { ...message, options }
  })
  assert.deepStrictEqual(postedMessagesWithoutFrontMatter, [
    {
      command: 'update',
      content: '# Example',
      documentVersion: 1,
      editorGeneration: 1,
      scrollTop: 0,
      type: 'init',
      options: {
        useVscodeThemeColor: undefined,
        mode: expectedMode,
        toolbarShortcuts: postedMessages[0].options.toolbarShortcuts,
      },
      theme: 'light',
      workspaceStyleCss: null,
      workspaceStylePath: null,
    },
  ])

  assert.strictEqual(
    typeof configurationListener,
    'function',
    'the editor did not listen for live shortcut configuration changes'
  )
  configurationListener({
    affectsConfiguration(section, scope) {
      return section === 'markdown-interactor.toolbarShortcuts' && scope === markdownUri
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.strictEqual(
    postedMessages[1]?.command,
    'toolbar-shortcuts',
    'a shortcut setting change was not delivered to the open Webview'
  )
  assert.strictEqual(postedMessages[1]?.shortcuts?.bold, 'Mod+B')
}

async function testInitialReadyMessages() {
  await openEditor('sv', 'sv')
  await openEditor('unsupported', 'wysiwyg')
}

testInitialReadyMessages()
  .then(() => console.log('custom editor startup tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
