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

// The single Custom Editor starts in the last valid toolbar-selected mode.
configValues = {}
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

const shortcutOptions = optionsFor({
  toolbarShortcuts: {
    bold: 'Mod+Alt+B',
    italic: '',
    save: 'Mod+C',
    code: 'Q',
    'math-inline': 'Mod+Alt+Q',
    'math-block': 'Mod+Alt+Q',
    unknown: 'Mod+U',
  },
}).toolbarShortcuts
assert.strictEqual(
  shortcutOptions.bold,
  'Mod+Alt+B',
  'a valid configured toolbar shortcut did not override its default'
)
assert.strictEqual(
  shortcutOptions.italic,
  '',
  'an empty shortcut did not disable the toolbar action'
)
assert.strictEqual(
  shortcutOptions.save,
  'Mod+S',
  'a reserved editor shortcut replaced a valid default'
)
assert.strictEqual(
  shortcutOptions.code,
  'Mod+Alt+C',
  'an unmodified character shortcut replaced a valid default'
)
assert.strictEqual(
  shortcutOptions['math-inline'],
  '',
  'a conflicting shortcut was assigned to one action'
)
assert.strictEqual(
  shortcutOptions['math-block'],
  '',
  'both sides of a shortcut conflict were not disabled'
)
assert.ok(
  !Object.prototype.hasOwnProperty.call(shortcutOptions, 'unknown'),
  'an unknown toolbar action entered the Webview options'
)

configValues = {}
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
assert.strictEqual(
  withSaved.toolbarShortcuts.save,
  'Mod+S',
  'the default toolbar shortcut configuration was not included'
)
assert.strictEqual(
  withSaved.toolbarShortcuts.bold,
  'Mod+B',
  'the default bold shortcut was not included'
)
const {
  toolbarShortcuts,
  frontMatterDisplay: _frontMatterDisplay,
  ...optionsWithoutShortcuts
} = withSaved
assert.ok(
  Object.keys(toolbarShortcuts).length > 30,
  'not every toolbar operation received a configurable shortcut slot'
)
assert.deepStrictEqual(
  optionsWithoutShortcuts,
  {
    useVscodeThemeColor: undefined,
    mode: 'sv',
  },
  'persisted state must restore only the validated editor mode'
)

console.log('vditor options tests passed')
