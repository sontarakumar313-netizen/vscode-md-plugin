const assert = require('assert')
const Module = require('module')
const path = require('path')
const { buildSync } = require('esbuild')

/**
 * Covers the host's settings boundary. The webview trusts whatever arrives in the
 * options message, so an unknown or hand-edited value has to be rejected here.
 */

let configValues = {}
const disposable = () => ({ dispose() {} })
const vscode = {
  Uri: { file: (value) => ({ fsPath: value, scheme: 'file' }) },
  EventEmitter: class {
    constructor() {
      this.event = () => disposable()
    }
    fire() {}
    dispose() {}
  },
  window: {
    activeColorTheme: { kind: 1 },
    onDidChangeActiveColorTheme: () => disposable(),
    showErrorMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
  },
  workspace: {
    workspaceFolders: undefined,
    getWorkspaceFolder: () => undefined,
    getConfiguration: () => ({
      get: (key) => configValues[key],
    }),
    onDidChangeTextDocument: () => disposable(),
    fs: {},
  },
  ViewColumn: { Active: -1 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
}

const sourcePath = path.resolve(__dirname, '../src/webview.ts')
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

const { getVditorOptions } = compiledModule.exports
const context = { globalState: { get: () => undefined } }
const optionsFor = (values) => {
  configValues = values
  return getVditorOptions(context, undefined)
}

for (const mode of ['table', 'codeBlock', 'hide']) {
  assert.strictEqual(
    optionsFor({ frontMatterDisplay: mode }).frontMatterDisplay,
    mode,
    `a valid front matter display mode must pass through: ${mode}`
  )
}

// settings.json is hand-editable, so anything can arrive here.
for (const rejected of [
  'Table',
  'code-block',
  'unknown',
  '',
  undefined,
  null,
  42,
  true,
  ['table'],
  { mode: 'table' },
]) {
  assert.strictEqual(
    optionsFor({ frontMatterDisplay: rejected }).frontMatterDisplay,
    'table',
    `an unusable front matter display value must fall back to table: ${JSON.stringify(
      rejected
    )}`
  )
}

// Saved editor state must not be able to smuggle an unvalidated value through.
configValues = { frontMatterDisplay: 'hide' }
assert.strictEqual(
  getVditorOptions(
    { globalState: { get: () => ({ frontMatterDisplay: 'bogus' }) } },
    undefined
  ).frontMatterDisplay,
  'hide',
  'a value left in saved editor state must not override the validated setting'
)

// The single Custom Editor starts in the last valid toolbar-selected mode.
configValues = { frontMatterDisplay: 'table' }
for (const savedMode of ['wysiwyg', 'sv']) {
  assert.strictEqual(
    getVditorOptions(
      { globalState: { get: () => ({ mode: savedMode }) } },
      undefined
    ).mode,
    savedMode,
    `the valid saved mode was not restored: ${savedMode}`
  )
}

const removedMode = ['i', 'r'].join('')
for (const savedMode of [
  removedMode,
  undefined,
  null,
  '',
  'legacy-mode',
  42,
  true,
  {},
]) {
  assert.strictEqual(
    getVditorOptions(
      { globalState: { get: () => ({ mode: savedMode }) } },
      undefined
    ).mode,
    'wysiwyg',
    `an invalid saved mode did not fall back to WYSIWYG: ${JSON.stringify(
      savedMode
    )}`
  )
}

const withSaved = getVditorOptions(
  {
    globalState: {
      get: () => ({
        mode: 'sv',
        theme: 'dark',
        preview: {},
        lang: 'de_DE',
        hint: { emojiPath: 'https://example.invalid' },
      }),
    },
  },
  undefined
)
assert.deepStrictEqual(
  withSaved,
  {
    useVscodeThemeColor: undefined,
    mode: 'sv',
    frontMatterDisplay: 'table',
  },
  'persisted state must restore only the validated editor mode'
)

console.log('vditor options tests passed')
