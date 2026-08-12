const assert = require('assert')
const Module = require('module')
const path = require('path')
const { buildSync } = require('esbuild')

function disposable() {
  return { dispose() {} }
}

function makeUri(fsPath) {
  return {
    fsPath,
    toString() {
      return `file://${fsPath.replace(/\\/g, '/')}`
    },
  }
}

const configurationValues = {}
const statusMessages = []
let warningMessageCalls = 0
let applyEditHandler = async () => true

class Range {
  constructor(start, end) {
    this.start = start
    this.end = end
  }
}

class WorkspaceEdit {
  constructor() {
    this.replacements = []
  }

  replace(uri, range, text) {
    this.replacements.push({ uri, range, text })
  }
}

const vscode = {
  Range,
  WorkspaceEdit,
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
    showWarningMessage: async () => {
      warningMessageCalls += 1
      return undefined
    },
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    setStatusBarMessage(message) {
      statusMessages.push(message)
      return disposable()
    },
  },
  workspace: {
    applyEdit: (edit) => applyEditHandler(edit),
    getConfiguration: () => ({ get: (key) => configurationValues[key] }),
    getWorkspaceFolder: () => undefined,
  },
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

const {
  MarkdownWebviewController,
  applyMinimalDocumentEdit,
  getUploadMaxBytes,
  getWebviewHtml,
  isRemoteMediaAllowed,
  validateWebviewUploadFile,
} = compiledModule.exports

function createController({
  getSnapshot,
  syncToDocument,
  postMessage,
  updateGlobalState = async () => {},
}) {
  let receiveMessage
  const webview = {
    onDidReceiveMessage(listener) {
      receiveMessage = listener
      return disposable()
    },
    postMessage,
  }
  const document = {
    uri: makeUri('C:/workspace/example.md'),
    version: 1,
    getText: () => '',
  }
  const controller = new MarkdownWebviewController({
    context: {
      globalState: {
        get: () => ({}),
        update: updateGlobalState,
      },
    },
    panel: { webview },
    uri: document.uri,
    mode: 'wysiwyg',
    isDisposed: () => false,
    getSnapshot,
    syncToDocument,
    getAssetsFolder: () => 'C:/workspace/assets',
    openLink: async () => {},
    getScrollTop: () => 0,
    saveScrollPosition: () => {},
  })

  const withCurrentGeneration = (message) => {
    if (
      message &&
      ['edit', 'save', 'reset-config', 'normalize-formatting'].includes(
        message.command
      ) &&
      message.generation === undefined
    ) {
      return { ...message, generation: controller.editorGeneration }
    }
    return message
  }

  return {
    controller,
    receive(message) {
      receiveMessage(withCurrentGeneration(message))
    },
    receiveRaw(message) {
      receiveMessage(message)
    },
  }
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await nextTurn()
  }
  throw new Error(message)
}

function reportBaseline(
  controller,
  receive,
  content,
  documentVersion,
  projectionSerial = 1,
  generation = controller.editorGeneration
) {
  receive({
    command: 'editor-baseline',
    content,
    documentVersion,
    generation,
    projectionSerial,
  })
}

function testUploadValidation() {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ])
  const base64 = png.toString('base64')
  const acceptedPng = validateWebviewUploadFile({
    name: 'image.png',
    base64,
    mime: 'image/png',
    size: png.length,
  })
  assert.deepStrictEqual(
    acceptedPng.content,
    png,
    'a correctly-declared PNG must be accepted'
  )
  assert.strictEqual(acceptedPng.name, 'image.png')
  assert.strictEqual(
    validateWebviewUploadFile({
      name: 'clipboard-image',
      base64,
      mime: 'image/png',
      size: png.length,
    }).name,
    'clipboard-image.png',
    'a verified extensionless clipboard upload must receive a safe suffix'
  )
  assert.throws(
    () =>
      validateWebviewUploadFile({
        name: '../image.png',
        base64,
        mime: 'image/png',
        size: png.length,
      }),
    /Invalid upload file name/
  )
  assert.throws(
    () =>
      validateWebviewUploadFile({
        name: 'image.png',
        base64,
        mime: 'image/jpeg',
        size: png.length,
      }),
    /MIME type/
  )
  assert.throws(
    () =>
      validateWebviewUploadFile({
        name: 'image.jpg',
        base64,
        mime: 'image/png',
        size: png.length,
      }),
    /extension/
  )
  assert.throws(
    () =>
      validateWebviewUploadFile({
        name: 'image.png',
        base64,
        mime: 'image/png',
        size: png.length + 1,
      }),
    /size did not match/
  )
  assert.throws(
    () =>
      validateWebviewUploadFile({
        name: 'image.png',
        base64: 'not base64!',
        mime: 'image/png',
      }),
    /Invalid or oversized/
  )
}

function testResourceScopedSafetySettings() {
  const uri = makeUri('C:/workspace/example.md')
  const webview = {
    cspSource: 'vscode-webview://test',
    asWebviewUri: (resource) => resource,
  }
  const context = { extensionUri: makeUri('C:/extension') }
  assert.strictEqual(isRemoteMediaAllowed(uri), true)
  const defaultHtml = getWebviewHtml(context, webview, uri)
  assert.ok(defaultHtml.includes('img-src vscode-webview://test https: data: blob:'))

  configurationValues.allowRemoteMedia = false
  assert.strictEqual(isRemoteMediaAllowed(uri), false)
  const restrictedHtml = getWebviewHtml(context, webview, uri)
  assert.ok(restrictedHtml.includes('img-src vscode-webview://test data: blob:'))
  assert.ok(!restrictedHtml.includes('img-src vscode-webview://test https:'))
  delete configurationValues.allowRemoteMedia

  configurationValues.maxUploadSizeMB = 0.5
  assert.strictEqual(getUploadMaxBytes(uri), 1024 * 1024)
  configurationValues.maxUploadSizeMB = 200
  assert.strictEqual(getUploadMaxBytes(uri), 100 * 1024 * 1024)
  delete configurationValues.maxUploadSizeMB
}

async function testCrlfEditUsesCanonicalLfAndMinimalWrite() {
  let text = 'alpha  \r\nbeta'
  const document = {
    uri: makeUri('C:/workspace/crlf.md'),
    eol: 2,
    version: 1,
    getText: () => text,
    positionAt: (offset) => offset,
  }
  const replacements = []
  let controller
  let ownEchoRecognized = false
  applyEditHandler = async (edit) => {
    assert.strictEqual(edit.replacements.length, 1)
    const replacement = edit.replacements[0]
    replacements.push(replacement)
    text =
      text.slice(0, replacement.range.start) +
      replacement.text +
      text.slice(replacement.range.end)
    document.version += 1
    ownEchoRecognized = controller.observeDocumentChange(document)
    return true
  }

  const posted = []
  const warningCallsBefore = warningMessageCalls
  const created = createController({
    getSnapshot: async () => ({
      content: document.getText(),
      version: document.version,
    }),
    syncToDocument: (content) => applyMinimalDocumentEdit(document, content),
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })
  controller = created.controller
  const { receive } = created
  controller.rememberSnapshot({ content: 'alpha  \nbeta', version: 1 })
  reportBaseline(controller, receive, 'alpha\nbeta', 1)

  receive({
    command: 'edit',
    content: 'alpha\nbeta!',
    seq: 1,
    baseVersion: 1,
  })
  await waitFor(
    () => posted.some((message) => message.command === 'edit-ack'),
    'CRLF edit was not acknowledged'
  )

  assert.strictEqual(
    text,
    'alpha  \r\nbeta!',
    'the document EOL or untouched trailing spaces were not preserved'
  )
  assert.strictEqual(replacements.length, 1)
  assert.strictEqual(replacements[0].text, '!')
  assert.strictEqual(
    replacements[0].range.start,
    replacements[0].range.end,
    'a one-character edit unexpectedly replaced existing document content'
  )
  assert.deepStrictEqual(
    posted.filter((message) => message.command === 'edit-ack'),
    [
      {
        command: 'edit-ack',
        seq: 1,
        documentVersion: 2,
        content: 'alpha\nbeta!',
        merged: false,
        generation: 0,
      },
    ]
  )
  assert.strictEqual(
    ownEchoRecognized,
    true,
    'the CRLF document event was not recognized as the controller own echo'
  )
  assert.strictEqual(warningMessageCalls, warningCallsBefore)
  controller.dispose()
  applyEditHandler = async () => true
}

async function testOverlappingExternalEditPrefersEditorHunk() {
  const base = 'header\nremote base\nseparator\nshared base\nfooter\n'
  let current = {
    content: 'header\nremote changed\nseparator\nshared remote\nfooter\n',
    version: 2,
  }
  const posted = []
  const statusBefore = statusMessages.length
  const warningCallsBefore = warningMessageCalls
  const { controller, receive } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      current = { content, version: current.version + 1 }
      return { version: current.version, getText: () => current.content }
    },
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })
  controller.rememberSnapshot({ content: base, version: 1 })

  receive({
    command: 'edit',
    content: 'header\nremote base\nseparator\nshared local\nfooter\n',
    seq: 1,
    baseVersion: 1,
  })
  await waitFor(
    () => posted.some((message) => message.command === 'edit-ack'),
    'local-preferred merge was not acknowledged'
  )

  assert.strictEqual(
    current.content,
    'header\nremote changed\nseparator\nshared local\nfooter\n',
    'the merge did not retain the independent remote edit and local overlap'
  )
  assert.strictEqual(
    posted.find((message) => message.command === 'edit-ack').merged,
    true
  )
  assert.strictEqual(statusMessages.length, statusBefore + 1)
  assert.strictEqual(warningMessageCalls, warningCallsBefore)
  controller.dispose()
}

async function testMissingMergeBaseFallsBackToEditor() {
  let current = { content: 'external only', version: 9 }
  const posted = []
  const statusBefore = statusMessages.length
  const warningCallsBefore = warningMessageCalls
  const { controller, receive } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      current = { content, version: current.version + 1 }
      return { version: current.version, getText: () => current.content }
    },
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })

  receive({ command: 'edit', content: 'editor wins', seq: 1, baseVersion: 1 })
  await waitFor(
    () => posted.some((message) => message.command === 'edit-ack'),
    'missing-base fallback was not acknowledged'
  )

  assert.strictEqual(current.content, 'editor wins')
  assert.strictEqual(
    posted.find((message) => message.command === 'edit-ack').merged,
    false
  )
  assert.strictEqual(statusMessages.length, statusBefore + 1)
  assert.strictEqual(warningMessageCalls, warningCallsBefore)
  controller.dispose()
}

async function testAcknowledgedContentIsUsedWhenHistoryWasEvicted() {
  const base = 'base\n'
  let current = { content: 'base\nexternal merged\n', version: 2 }
  const posted = []
  const { controller, receive } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      current = { content, version: current.version + 1 }
      return { version: current.version, getText: () => current.content }
    },
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })
  controller.rememberSnapshot({ content: base, version: 1 })

  receive({ command: 'edit', content: 'local\n', seq: 1, baseVersion: 1 })
  await waitFor(
    () => posted.filter((message) => message.command === 'edit-ack').length === 1,
    'initial merged acknowledgement did not finish'
  )
  assert.strictEqual(current.content, 'local\nexternal merged\n')
  const acknowledgedVersion = current.version

  const evictedContent = controller.versionHistory.get(acknowledgedVersion)
  controller.versionHistory.delete(acknowledgedVersion)
  controller.versionHistoryBytes -= evictedContent.length * 2
  current = {
    content: 'local\nexternal merged\nnew external\n',
    version: acknowledgedVersion + 1,
  }
  receive({
    command: 'edit',
    content: 'local\n',
    seq: 2,
    baseVersion: acknowledgedVersion,
  })
  await waitFor(
    () => posted.filter((message) => message.command === 'edit-ack').length === 2,
    'history-eviction acknowledgement did not finish'
  )

  assert.strictEqual(
    current.content,
    'local\nnew external\n',
    'using the pre-merge source as an acknowledged base restored deleted content'
  )
  controller.dispose()
}

async function testPreAcknowledgementEditUsesEditorSourceAsBase() {
  const base = 'base\n'
  let current = { content: 'base\nexternal\n', version: 2 }
  let releaseFirstWrite
  const firstWriteBlocked = new Promise((resolve) => {
    releaseFirstWrite = resolve
  })
  let writeCount = 0
  const posted = []
  const { controller, receive } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      writeCount += 1
      if (writeCount === 1) await firstWriteBlocked
      current = { content, version: current.version + 1 }
      return { version: current.version, getText: () => current.content }
    },
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })
  controller.rememberSnapshot({ content: base, version: 1 })

  receive({ command: 'edit', content: 'local\n', seq: 1, baseVersion: 1 })
  await nextTurn()
  receive({
    command: 'edit',
    content: 'local edited\n',
    seq: 2,
    baseVersion: 1,
  })
  releaseFirstWrite()

  await waitFor(
    () => posted.filter((message) => message.command === 'edit-ack').length === 2,
    'pre-ack sequential edits did not finish'
  )
  assert.strictEqual(
    current.content,
    'local edited\nexternal\n',
    'a pre-ack edit did not preserve the remote content merged into its ancestor'
  )
  controller.dispose()
}

async function testPreAckCanonicalEditUsesEffectiveBaseline() {
  const originTemplate = '* [x] done\n\ncount: VALUE\n'
  const baselineTemplate = '- [X]  done\n\ncount: VALUE\n'
  let current = { content: originTemplate.replace('VALUE', '0'), version: 1 }
  let releaseFirstWrite
  const firstWriteBlocked = new Promise((resolve) => {
    releaseFirstWrite = resolve
  })
  let writeCount = 0
  const posted = []
  const { controller, receive } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      writeCount += 1
      if (writeCount === 1) await firstWriteBlocked
      current = { content, version: current.version + 1 }
      return { version: current.version, getText: () => current.content }
    },
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })
  controller.rememberSnapshot(current)
  reportBaseline(controller, receive, baselineTemplate.replace('VALUE', '0'), 1)

  receive({
    command: 'edit',
    content: baselineTemplate.replace('VALUE', '1'),
    seq: 1,
    baseVersion: 1,
  })
  await nextTurn()
  receive({
    command: 'edit',
    content: baselineTemplate.replace('VALUE', '2'),
    seq: 2,
    baseVersion: 1,
  })
  releaseFirstWrite()
  await waitFor(
    () => posted.filter((message) => message.command === 'edit-ack').length === 2,
    'pre-ack canonical edits did not finish'
  )

  assert.strictEqual(
    current.content,
    originTemplate.replace('VALUE', '2'),
    'pre-ack canonical edit was merged again in mixed coordinate spaces'
  )
  controller.dispose()
}

async function testCanonicalBaselineReconcilesEditorEdit() {
  const origin = '| a | b |\n| - | - |\n\nsentinel old\n'
  const baseline = '| a | b |\n| --- | --- |\n\nsentinel old\n'
  const local = baseline.replace('sentinel old', 'sentinel new')
  let current = { content: origin, version: 1 }
  const writes = []
  const posted = []
  const { controller, receive } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      writes.push(content)
      current = { content, version: current.version + 1 }
      return { version: current.version, getText: () => current.content }
    },
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })
  controller.rememberSnapshot(current)
  reportBaseline(controller, receive, baseline, 1)
  receive({ command: 'edit', content: local, seq: 1, baseVersion: 1 })
  await waitFor(
    () => posted.some((message) => message.command === 'edit-ack'),
    'canonical edit was not acknowledged'
  )

  assert.deepStrictEqual(writes, [origin.replace('sentinel old', 'sentinel new')])
  assert.deepStrictEqual(
    posted.find((message) => message.command === 'edit-ack'),
    {
      command: 'edit-ack',
      seq: 1,
      documentVersion: 2,
      content: local,
      merged: false,
      generation: 0,
    },
    'a reconciliation-only ack should remain in editor space'
  )
  assert.strictEqual(controller.editorBaseline.content, local)
  assert.strictEqual(controller.editorBaseline.origin, current.content)
  assert.strictEqual(controller.editorBaseline.provenance, 'derived')
  controller.dispose()
}

async function testBlankGapQuotePreservesOriginFormatting() {
  const origin = 'first\n\n\n\nsecond\n'
  const baseline = 'first\n\nsecond\n'
  const local = 'first\n\n> Quote content\n\nsecond\n'
  let current = { content: origin, version: 1 }
  const writes = []
  const posted = []
  const { controller, receive } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      writes.push(content)
      current = { content, version: current.version + 1 }
      return { version: current.version, getText: () => current.content }
    },
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })
  controller.rememberSnapshot(current)
  reportBaseline(controller, receive, baseline, 1)
  receive({ command: 'edit', content: local, seq: 1, baseVersion: 1 })
  await waitFor(
    () => posted.some((message) => message.command === 'edit-ack'),
    'blank-gap quote edit was not acknowledged'
  )

  assert.deepStrictEqual(
    writes,
    ['first\n\n\n\n> Quote content\n\nsecond\n'],
    'inserting a quote in a canonicalised blank gap removed original blank lines'
  )
  assert.strictEqual(
    current.content.replace('> Quote content\n\n', ''),
    origin,
    'removing the inserted quote did not recover the original formatting'
  )
  controller.dispose()
}

async function testSaveWithoutEditPreservesOriginFormatting() {
  const origin = '* [x] done\n'
  const baseline = '- [X]  done\n'
  let current = { content: origin, version: 1 }
  let saved = false
  const writes = []
  const posted = []
  const { controller, receive } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      writes.push(content)
      return {
        version: current.version,
        getText: () => current.content,
        save: async () => {
          saved = true
          return true
        },
      }
    },
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })
  controller.rememberSnapshot(current)
  reportBaseline(controller, receive, baseline, 1)
  receive({ command: 'save', content: baseline, seq: 1, baseVersion: 1 })
  await waitFor(() => saved, 'save did not finish')

  assert.deepStrictEqual(writes, [origin])
  assert.strictEqual(current.content, origin)
  assert.strictEqual(
    posted.find((message) => message.command === 'edit-ack').content,
    baseline
  )
  controller.dispose()
}

async function testCanonicalAndExternalMergesStayLayered() {
  const origin = '* [x] done\n\nfooter old\n'
  const baseline = '- [X]  done\n\nfooter old\n'
  const local = baseline.replace('done', 'done locally')
  let current = {
    content: origin.replace('footer old', 'footer external'),
    version: 2,
  }
  const posted = []
  const { controller, receive } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      current = { content, version: current.version + 1 }
      return { version: current.version, getText: () => current.content }
    },
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })
  controller.rememberSnapshot({ content: origin, version: 1 })
  reportBaseline(controller, receive, baseline, 1)
  receive({ command: 'edit', content: local, seq: 1, baseVersion: 1 })
  await waitFor(
    () => posted.some((message) => message.command === 'edit-ack'),
    'layered merge did not finish'
  )

  assert.strictEqual(
    current.content,
    '* [x] done locally\n\nfooter external\n',
    'canonical reconciliation must run before the external merge'
  )
  const acknowledgement = posted.find(
    (message) => message.command === 'edit-ack'
  )
  assert.strictEqual(acknowledgement.merged, true)
  assert.strictEqual(acknowledgement.content, current.content)
  assert.strictEqual(
    controller.editorBaseline.version,
    1,
    'external merge must wait for an authoritative renderer baseline'
  )
  controller.dispose()
}

async function testNormalizeFormattingRetainsConcurrentExternalEdit() {
  const origin = '* [x] done\n\nfooter old\n'
  const baseline = '- [X]  done\n\nfooter old\n'
  let current = {
    content: origin.replace('footer old', 'footer external'),
    version: 2,
  }
  const writes = []
  const posted = []
  const { controller, receive } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      writes.push(content)
      current = { content, version: current.version + 1 }
      return { version: current.version, getText: () => current.content }
    },
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })
  controller.rememberSnapshot({ content: origin, version: 1 })
  reportBaseline(controller, receive, baseline, 1)
  receive({
    command: 'normalize-formatting',
    content: baseline,
    seq: 1,
    baseVersion: 1,
  })
  await waitFor(
    () => posted.some((message) => message.command === 'edit-ack'),
    'normalization with an external edit did not finish'
  )

  assert.deepStrictEqual(writes, [
    '- [X]  done\n\nfooter external\n',
  ])
  assert.strictEqual(
    posted.find((message) => message.command === 'edit-ack').merged,
    true,
    'normalization did not report the external merge'
  )
  controller.dispose()
}

async function testTwelveCanonicalEditsDoNotAccumulateDrift() {
  const originTemplate = '* [x] done\n\ncount: VALUE\n'
  const baselineTemplate = '- [X]  done\n\ncount: VALUE\n'
  let current = { content: originTemplate.replace('VALUE', '0'), version: 1 }
  const posted = []
  const { controller, receive } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      current = { content, version: current.version + 1 }
      return { version: current.version, getText: () => current.content }
    },
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })
  controller.rememberSnapshot(current)
  reportBaseline(controller, receive, baselineTemplate.replace('VALUE', '0'), 1)

  for (let index = 1; index <= 12; index += 1) {
    receive({
      command: 'edit',
      content: baselineTemplate.replace('VALUE', String(index)),
      seq: index,
      baseVersion: current.version,
    })
    await waitFor(
      () => posted.filter((message) => message.command === 'edit-ack').length === index,
      `canonical edit ${index} did not finish`
    )
    assert.strictEqual(
      current.content,
      originTemplate.replace('VALUE', String(index)),
      `canonical drift accumulated after edit ${index}`
    )
  }
  controller.dispose()
}

async function testCapturedBaselineSurvivesReportRaceAndHistoryEviction() {
  const originOne = 'original one\n\nsentinel old\n'
  const baselineOne = 'canonical one\n\nsentinel old\n'
  const originTwo = 'original two\n\nsentinel old\n'
  const baselineTwo = 'canonical two\n\nsentinel old\n'
  let releaseSnapshot
  const pendingSnapshot = new Promise((resolve) => {
    releaseSnapshot = resolve
  })
  let current = { content: originOne, version: 1 }
  const writes = []
  const posted = []
  const { controller, receive } = createController({
    getSnapshot: async () => pendingSnapshot,
    syncToDocument: async (content) => {
      writes.push(content)
      current = { content, version: 2 }
      return { version: 2, getText: () => current.content }
    },
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })
  controller.rememberSnapshot({ content: originOne, version: 1 })
  reportBaseline(controller, receive, baselineOne, 1)
  receive({
    command: 'edit',
    content: baselineOne.replace('sentinel old', 'sentinel new'),
    seq: 1,
    baseVersion: 1,
  })
  await nextTurn()

  controller.rememberSnapshot({ content: originTwo, version: 2 })
  reportBaseline(controller, receive, baselineTwo, 2, 2)
  // Evict the original history entry; the captured baseline pins its own origin.
  controller.versionHistory.delete(1)
  releaseSnapshot({ content: originOne, version: 1 })
  await waitFor(
    () => posted.some((message) => message.command === 'edit-ack'),
    'baseline race edit did not finish'
  )

  assert.deepStrictEqual(writes, [originOne.replace('sentinel old', 'sentinel new')])
  assert.strictEqual(controller.editorBaseline.content, baselineTwo)
  assert.strictEqual(controller.editorBaseline.provenance, 'renderer')
  controller.dispose()
}

function testBaselineValidationAndMonotonicOrdering() {
  const posted = []
  const current = { content: 'origin one', version: 1 }
  const { controller, receiveRaw } = createController({
    getSnapshot: async () => current,
    syncToDocument: async () => undefined,
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })
  controller.rememberSnapshot(current)
  receiveRaw({
    command: 'editor-baseline',
    content: 'invalid',
    documentVersion: 1,
    generation: 0,
    projectionSerial: 0,
  })
  receiveRaw({
    command: 'editor-baseline',
    content: 'wrong generation',
    documentVersion: 1,
    generation: 9,
    projectionSerial: 1,
  })
  assert.strictEqual(controller.editorBaseline, undefined)

  receiveRaw({
    command: 'editor-baseline',
    content: 'baseline one',
    documentVersion: 1,
    generation: 0,
    projectionSerial: 1,
  })
  controller.rememberSnapshot({ content: 'origin two', version: 2 })
  receiveRaw({
    command: 'editor-baseline',
    content: 'baseline two',
    documentVersion: 2,
    generation: 0,
    projectionSerial: 2,
  })
  receiveRaw({
    command: 'editor-baseline',
    content: 'stale baseline',
    documentVersion: 1,
    generation: 0,
    projectionSerial: 99,
  })
  receiveRaw({
    command: 'editor-baseline',
    content: 'older serial',
    documentVersion: 2,
    generation: 0,
    projectionSerial: 1,
  })
  assert.strictEqual(controller.editorBaseline.content, 'baseline two')
  assert.strictEqual(controller.editorBaseline.origin, 'origin two')
  controller.dispose()
}

async function testGenerationDisposalAndNormalizationSafety() {
  const origin = '* [x] done\n'
  const baseline = '- [X]  done\n'
  let current = { content: origin, version: 1 }
  let releaseWrite
  let blockWrites = false
  const pendingWrite = new Promise((resolve) => {
    releaseWrite = resolve
  })
  const writes = []
  const posted = []
  const created = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      writes.push(content)
      if (blockWrites) await pendingWrite
      current = { content, version: current.version + 1 }
      return { version: current.version, getText: () => current.content }
    },
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })
  const { controller, receive, receiveRaw } = created
  controller.rememberSnapshot(current)
  reportBaseline(controller, receive, baseline, 1)

  receiveRaw({
    command: 'edit',
    content: `${baseline}stale`,
    seq: 1,
    baseVersion: 1,
    generation: 99,
  })
  await nextTurn()
  assert.deepStrictEqual(writes, [], 'a stale-generation edit reached the document')

  receive({
    command: 'normalize-formatting',
    content: baseline,
    seq: 2,
    baseVersion: 1,
  })
  await waitFor(() => writes.length === 1, 'normalization did not finish')
  assert.strictEqual(writes[0], baseline, 'normalization was incorrectly reconciled')
  assert.strictEqual(controller.editorBaseline.origin, baseline)

  blockWrites = true
  receive({
    command: 'edit',
    content: `${baseline}new edit\n`,
    seq: 3,
    baseVersion: current.version,
  })
  await nextTurn()
  const acknowledgementsBeforeDispose = posted.filter(
    (message) => message.command === 'edit-ack'
  ).length
  controller.dispose()
  releaseWrite()
  await nextTurn()
  await nextTurn()
  assert.strictEqual(
    posted.filter((message) => message.command === 'edit-ack').length,
    acknowledgementsBeforeDispose,
    'dispose allowed an in-flight stale acknowledgement'
  )
}

async function testStaleGenerationCannotSupersedeQueuedEdit() {
  let current = { content: 'base', version: 1 }
  let releaseFirstWrite
  const firstWriteBlocked = new Promise((resolve) => {
    releaseFirstWrite = resolve
  })
  let writeCount = 0
  const posted = []
  const { controller, receive, receiveRaw } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      writeCount += 1
      if (writeCount === 1) await firstWriteBlocked
      current = { content, version: current.version + 1 }
      return { version: current.version, getText: () => current.content }
    },
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })

  receive({ command: 'edit', content: 'first', seq: 1, baseVersion: 1 })
  await nextTurn()
  receive({ command: 'edit', content: 'second', seq: 2, baseVersion: 1 })
  receiveRaw({
    command: 'edit',
    content: 'stale',
    seq: 3,
    baseVersion: 1,
    generation: 99,
  })
  releaseFirstWrite()
  await waitFor(
    () => posted.filter((message) => message.command === 'edit-ack').length === 2,
    'valid queued edit was superseded by a stale generation'
  )
  assert.deepStrictEqual(
    posted
      .filter((message) => message.command === 'edit-ack')
      .map((message) => message.seq),
    [1, 2]
  )
  controller.dispose()
}

async function testQueuedEditsAreCoalesced() {
  let current = { content: 'base', version: 1 }
  let releaseFirstEdit
  const firstEditStarted = new Promise((resolve) => {
    releaseFirstEdit = resolve
  })
  const writes = []
  const posted = []
  const { controller, receive } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      writes.push(content)
      if (content === 'first') await firstEditStarted
      current = { content, version: current.version + 1 }
      return {
        version: current.version,
        getText: () => current.content,
      }
    },
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })

  receive({ command: 'edit', content: 'first', seq: 1, baseVersion: 1 })
  await nextTurn()
  receive({ command: 'edit', content: 'second', seq: 2, baseVersion: 1 })
  receive({ command: 'edit', content: 'third', seq: 3, baseVersion: 1 })
  releaseFirstEdit()

  await waitFor(
    () => posted.filter((message) => message.command === 'edit-ack').length === 2,
    'coalesced edits did not finish'
  )
  assert.deepStrictEqual(
    writes,
    ['first', 'third'],
    'only the latest queued full-document edit should reach VS Code'
  )
  assert.deepStrictEqual(
    posted
      .filter((message) => message.command === 'edit-ack')
      .map((message) => message.seq),
    [1, 3],
    'the superseded edit must not produce its own acknowledgement'
  )
  controller.dispose()
}

function testVersionHistoryHasABoundedMemoryBudget() {
  const { controller } = createController({
    getSnapshot: async () => ({ content: '', version: 0 }),
    syncToDocument: async () => undefined,
    postMessage: async () => true,
  })
  const megabyte = 'x'.repeat(1024 * 1024)
  for (let version = 1; version <= 8; version += 1) {
    controller.rememberSnapshot({ content: `${version}${megabyte.slice(1)}`, version })
  }

  assert.ok(
    controller.versionHistoryBytes <= 4 * 1024 * 1024,
    'retained snapshots must obey the byte budget for ordinary documents'
  )
  assert.ok(
    controller.versionHistory.has(8),
    'the newest snapshot must remain available as a merge base'
  )
  assert.ok(
    controller.versionHistory.size <= 2,
    'large documents must not retain a 50-version full-content history'
  )
  controller.dispose()
}

async function testOldGenerationEditSurvivesInitDeliveryGap() {
  const origin = '* [x] done\n'
  const baseline = '- [X]  done\n'
  let current = { content: origin, version: 1 }
  let releaseInit
  const initDelivery = new Promise((resolve) => {
    releaseInit = resolve
  })
  const posted = []
  const { controller, receive, receiveRaw } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      current = { content, version: current.version + 1 }
      return { version: current.version, getText: () => current.content }
    },
    postMessage: (message) => {
      posted.push(message)
      return message.command === 'update' && message.type === 'init'
        ? initDelivery
        : Promise.resolve(true)
    },
  })
  controller.rememberSnapshot(current)
  reportBaseline(controller, receive, baseline, 1)

  const initialization = controller.initialize()
  await waitFor(
    () => posted.some((message) => message.command === 'update' && message.type === 'init'),
    'pending init was not posted'
  )
  const initMessage = posted.find(
    (message) => message.command === 'update' && message.type === 'init'
  )
  assert.strictEqual(controller.editorGeneration, 0)
  assert.strictEqual(initMessage.editorGeneration, 1)

  receiveRaw({
    command: 'edit',
    content: baseline.replace('done', 'changed'),
    seq: 1,
    baseVersion: 1,
    generation: 0,
  })
  await waitFor(() => current.version === 2, 'old-generation gap edit was dropped')
  assert.strictEqual(current.content, '* [x] changed\n')

  releaseInit(true)
  await initialization
  receiveRaw({
    command: 'editor-baseline',
    content: baseline,
    documentVersion: 1,
    generation: 1,
    projectionSerial: 1,
  })
  await waitFor(
    () =>
      posted.some(
        (message) =>
          message.command === 'update' &&
          message.type !== 'init' &&
          message.editorGeneration === 1 &&
          message.documentVersion === 2 &&
          message.content === '* [x] changed\n'
      ),
    'promoted renderer did not receive the gap edit'
  )
  assert.strictEqual(controller.editorGeneration, 1)
  controller.dispose()
}

async function testInFlightOldGenerationEditRefreshesPromotedRenderer() {
  let current = { content: 'base\n', version: 1 }
  let releaseWrite
  const blockedWrite = new Promise((resolve) => {
    releaseWrite = resolve
  })
  const posted = []
  const { controller, receiveRaw } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      await blockedWrite
      current = { content, version: 2 }
      return { version: current.version, getText: () => current.content }
    },
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })
  controller.rememberSnapshot(current)
  await controller.initialize()
  const initMessage = posted.find(
    (message) => message.command === 'update' && message.type === 'init'
  )

  receiveRaw({
    command: 'edit',
    content: 'base old-renderer edit\n',
    seq: 1,
    baseVersion: 1,
    generation: 0,
  })
  await nextTurn()
  receiveRaw({
    command: 'editor-baseline',
    content: 'base\n',
    documentVersion: 1,
    generation: initMessage.editorGeneration,
    projectionSerial: 1,
  })
  assert.strictEqual(controller.editorGeneration, 1)

  releaseWrite()
  await waitFor(() => current.version === 2, 'in-flight old edit did not finish')
  await waitFor(
    () =>
      posted.some(
        (message) =>
          message.command === 'update' &&
          message.type !== 'init' &&
          message.editorGeneration === 1 &&
          message.content === 'base old-renderer edit\n'
      ),
    'promoted renderer was not refreshed after the in-flight old edit'
  )
  assert.ok(
    !posted.some(
      (message) => message.command === 'edit-ack' && message.generation === 0
    ),
    'a retired-generation acknowledgement was posted into the replacement renderer'
  )
  controller.dispose()
}

async function testPendingInitPinsOriginAcrossHistoryEviction() {
  const largeOrigin = `origin-${'x'.repeat(2 * 1024 * 1024)}`
  let current = { content: largeOrigin, version: 1 }
  const posted = []
  const { controller, receiveRaw } = createController({
    getSnapshot: async () => current,
    syncToDocument: async () => undefined,
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })

  await controller.initialize()
  const init = posted.find(
    (message) => message.command === 'update' && message.type === 'init'
  )
  current = { content: `newer-${'y'.repeat(2 * 1024 * 1024)}`, version: 2 }
  controller.rememberSnapshot(current)
  assert.ok(
    !controller.versionHistory.has(1),
    'the fixture did not evict the pending init version'
  )

  receiveRaw({
    command: 'editor-baseline',
    content: largeOrigin,
    documentVersion: 1,
    generation: init.editorGeneration,
    projectionSerial: 1,
  })
  assert.strictEqual(
    controller.editorGeneration,
    init.editorGeneration,
    'history eviction prevented pending-generation promotion'
  )
  assert.strictEqual(
    controller.editorBaseline.origin,
    largeOrigin,
    'pending baseline did not use its directly pinned init origin'
  )
  controller.dispose()
}

async function testRepeatedInitializationIsSerialized() {
  let current = { content: 'base\n', version: 1 }
  let releaseFirstInit
  const firstInitDelivery = new Promise((resolve) => {
    releaseFirstInit = resolve
  })
  const posted = []
  const { controller, receiveRaw } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      current = { content, version: current.version + 1 }
      return { version: current.version, getText: () => current.content }
    },
    postMessage: (message) => {
      posted.push(message)
      const initCount = posted.filter(
        (candidate) => candidate.command === 'update' && candidate.type === 'init'
      ).length
      return message.command === 'update' && message.type === 'init' && initCount === 1
        ? firstInitDelivery
        : Promise.resolve(true)
    },
  })

  const first = controller.initialize()
  await waitFor(
    () => posted.some((message) => message.command === 'update' && message.type === 'init'),
    'first serialized init was not posted'
  )
  await controller.initialize()
  assert.strictEqual(
    posted.filter((message) => message.command === 'update' && message.type === 'init').length,
    1,
    'a second initialize call superseded a delivered pending generation'
  )

  releaseFirstInit(true)
  await first
  receiveRaw({
    command: 'editor-baseline',
    content: 'base\n',
    documentVersion: 1,
    generation: 1,
    projectionSerial: 1,
  })
  await waitFor(
    () => posted.filter(
      (message) => message.command === 'update' && message.type === 'init'
    ).length === 2,
    'requested follow-up initialization was not serialized after promotion'
  )
  const initGenerations = posted
    .filter((message) => message.command === 'update' && message.type === 'init')
    .map((message) => message.editorGeneration)
  assert.deepStrictEqual(initGenerations, [1, 2])

  receiveRaw({
    command: 'editor-baseline',
    content: 'base\n',
    documentVersion: 1,
    generation: 2,
    projectionSerial: 1,
  })
  receiveRaw({
    command: 'edit',
    content: 'final renderer edit\n',
    seq: 1,
    baseVersion: 1,
    generation: 2,
  })
  await waitFor(() => current.content === 'final renderer edit\n', 'final generation edit was rejected')
  controller.dispose()
}

async function testInitializationRetryAfterFalseDelivery() {
  let current = { content: 'base\n', version: 1 }
  let releaseFirstInit
  const firstInitDelivery = new Promise((resolve) => {
    releaseFirstInit = resolve
  })
  const posted = []
  const { controller, receiveRaw } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      current = { content, version: current.version + 1 }
      return { version: current.version, getText: () => current.content }
    },
    postMessage: (message) => {
      posted.push(message)
      const initCount = posted.filter(
        (candidate) => candidate.command === 'update' && candidate.type === 'init'
      ).length
      return message.command === 'update' && message.type === 'init' && initCount === 1
        ? firstInitDelivery
        : Promise.resolve(true)
    },
  })

  const first = controller.initialize()
  await waitFor(() => posted.length === 1, 'false-delivery init was not posted')
  await controller.initialize()
  releaseFirstInit(false)
  await first
  await waitFor(
    () => posted.filter(
      (message) => message.command === 'update' && message.type === 'init'
    ).length === 2,
    'false init delivery did not start the requested retry'
  )
  const retry = posted.filter(
    (message) => message.command === 'update' && message.type === 'init'
  )[1]
  assert.strictEqual(retry.editorGeneration, 2, 'failed generation ID was reused')
  receiveRaw({
    command: 'editor-baseline',
    content: 'base\n',
    documentVersion: 1,
    generation: 2,
    projectionSerial: 1,
  })
  receiveRaw({
    command: 'edit',
    content: 'after false retry\n',
    seq: 1,
    baseVersion: 1,
    generation: 2,
  })
  await waitFor(() => current.content === 'after false retry\n', 'retry generation edit was rejected')
  controller.dispose()
}

async function testInitializationRetryAfterRejectedDelivery() {
  let current = { content: 'base\n', version: 1 }
  let rejectFirstInit
  const firstInitDelivery = new Promise((resolve, reject) => {
    rejectFirstInit = reject
  })
  const posted = []
  const { controller, receiveRaw } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      current = { content, version: current.version + 1 }
      return { version: current.version, getText: () => current.content }
    },
    postMessage: (message) => {
      posted.push(message)
      const initCount = posted.filter(
        (candidate) => candidate.command === 'update' && candidate.type === 'init'
      ).length
      return message.command === 'update' && message.type === 'init' && initCount === 1
        ? firstInitDelivery
        : Promise.resolve(true)
    },
  })

  const firstRejection = controller.initialize().then(
    () => undefined,
    (error) => error
  )
  await waitFor(() => posted.length === 1, 'rejected-delivery init was not posted')
  await controller.initialize()
  rejectFirstInit(new Error('delivery rejected'))
  assert.ok(await firstRejection, 'rejected init did not reject its own caller')
  await waitFor(
    () => posted.filter(
      (message) => message.command === 'update' && message.type === 'init'
    ).length === 2,
    'rejected init delivery did not start the requested retry'
  )
  const retry = posted.filter(
    (message) => message.command === 'update' && message.type === 'init'
  )[1]
  assert.strictEqual(retry.editorGeneration, 2, 'rejected generation ID was reused')
  receiveRaw({
    command: 'editor-baseline',
    content: 'base\n',
    documentVersion: 1,
    generation: 2,
    projectionSerial: 1,
  })
  receiveRaw({
    command: 'edit',
    content: 'after rejected retry\n',
    seq: 1,
    baseVersion: 1,
    generation: 2,
  })
  await waitFor(() => current.content === 'after rejected retry\n', 'rejected retry generation edit was lost')
  controller.dispose()
}

async function testEditAcknowledgementRetriesBeforeUpdate(failureMode) {
  let current = { content: 'base', version: 1 }
  let acknowledgementAttempts = 0
  const posted = []
  const { controller, receive } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      current = { content, version: current.version + 1 }
      return { version: current.version, getText: () => current.content }
    },
    postMessage: async (message) => {
      posted.push(message)
      if (message.command === 'edit-ack') {
        acknowledgementAttempts += 1
        if (acknowledgementAttempts === 1) {
          if (failureMode === 'reject') throw new Error('ack rejected')
          return false
        }
      }
      return true
    },
  })

  receive({ command: 'edit', content: 'local', seq: 1, baseVersion: 1 })
  await waitFor(() => acknowledgementAttempts === 1, `${failureMode} acknowledgement was not attempted`)
  current = { content: 'local plus external', version: 3 }
  await controller.update()
  assert.strictEqual(acknowledgementAttempts, 2, `${failureMode} acknowledgement was not retried`)
  const retryIndex = posted.findIndex(
    (message, index) => message.command === 'edit-ack' && index > posted.findIndex((item) => item.command === 'edit-ack')
  )
  const updateIndex = posted.findIndex((message) => message.command === 'update')
  assert.ok(retryIndex >= 0 && updateIndex > retryIndex, 'ack retry did not precede the host update')
  controller.dispose()
}

async function testSaveContinuesAfterAcknowledgementRejection() {
  let current = { content: 'base', version: 1 }
  let saved = false
  let acknowledgementAttempts = 0
  const { controller, receive } = createController({
    getSnapshot: async () => current,
    syncToDocument: async (content) => {
      current = { content, version: current.version + 1 }
      return {
        version: current.version,
        getText: () => current.content,
        save: async () => {
          saved = true
          return true
        },
      }
    },
    postMessage: async (message) => {
      if (message.command === 'edit-ack') {
        acknowledgementAttempts += 1
        throw new Error('ack rejected during save')
      }
      return true
    },
  })

  receive({ command: 'save', content: 'saved content', seq: 1, baseVersion: 1 })
  await waitFor(() => saved, 'ack rejection prevented document.save()')
  assert.strictEqual(acknowledgementAttempts, 1)
  controller.dispose()
}

async function testStaleHostSnapshotIsDiscardedAfterNewEditorEdit() {
  let snapshotCalls = 0
  let releaseStaleSnapshot
  const staleSnapshot = new Promise((resolve) => {
    releaseStaleSnapshot = resolve
  })
  let current = { content: 'base', version: 1 }
  const posted = []
  const { controller, receive } = createController({
    getSnapshot: async () => {
      snapshotCalls += 1
      return snapshotCalls === 1 ? staleSnapshot : current
    },
    syncToDocument: async (content) => {
      current = { content, version: current.version + 1 }
      return {
        version: current.version,
        getText: () => current.content,
      }
    },
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  })

  const hostUpdate = controller.update()
  receive({ command: 'edit', content: 'base local', seq: 1, baseVersion: 1 })
  await nextTurn()
  await nextTurn()

  releaseStaleSnapshot({ content: 'base', version: 1 })
  await hostUpdate

  assert.deepStrictEqual(
    posted.filter((message) => message.command === 'update'),
    [],
    'a host snapshot captured before a newer webview edit must not be delivered'
  )
  assert.deepStrictEqual(
    posted.filter((message) => message.command === 'edit-ack'),
    [
      {
        command: 'edit-ack',
        seq: 1,
        documentVersion: 2,
        content: 'base local',
        merged: false,
        generation: 0,
      },
    ]
  )
}

async function testSavedEditorModeIsIgnored() {
  const saved = []
  const { receive } = createController({
    getSnapshot: async () => ({ content: '', version: 1 }),
    syncToDocument: async () => undefined,
    postMessage: async () => true,
    updateGlobalState: async (_key, value) => {
      saved.push(value)
    },
  })

  receive({
    command: 'save-options',
    options: { mode: 'sv', retained: true },
  })
  await nextTurn()
  await nextTurn()
  assert.deepStrictEqual(
    saved,
    [],
    'an obsolete webview mode message changed persisted editor state'
  )
}

async function testConcurrentHostUpdatesAreCoalesced() {
  const posted = []
  let releaseDelivery
  const delivered = new Promise((resolve) => {
    releaseDelivery = resolve
  })
  const { controller } = createController({
    getSnapshot: async () => ({ content: 'same', version: 4 }),
    syncToDocument: async () => undefined,
    postMessage: (message) => {
      posted.push(message)
      return message.command === 'update' ? delivered : Promise.resolve(true)
    },
  })

  const first = controller.update()
  const second = controller.update()
  await nextTurn()
  await nextTurn()

  assert.strictEqual(
    posted.filter((message) => message.command === 'update').length,
    1,
    'concurrent document notifications must share one webview update'
  )

  releaseDelivery(true)
  await Promise.all([first, second])
}

Promise.resolve()
  .then(testUploadValidation)
  .then(testResourceScopedSafetySettings)
  .then(testSavedEditorModeIsIgnored)
  .then(testCrlfEditUsesCanonicalLfAndMinimalWrite)
  .then(testOverlappingExternalEditPrefersEditorHunk)
  .then(testMissingMergeBaseFallsBackToEditor)
  .then(testAcknowledgedContentIsUsedWhenHistoryWasEvicted)
  .then(testPreAcknowledgementEditUsesEditorSourceAsBase)
  .then(testPreAckCanonicalEditUsesEffectiveBaseline)
  .then(testCanonicalBaselineReconcilesEditorEdit)
  .then(testBlankGapQuotePreservesOriginFormatting)
  .then(testSaveWithoutEditPreservesOriginFormatting)
  .then(testCanonicalAndExternalMergesStayLayered)
  .then(testNormalizeFormattingRetainsConcurrentExternalEdit)
  .then(testTwelveCanonicalEditsDoNotAccumulateDrift)
  .then(testCapturedBaselineSurvivesReportRaceAndHistoryEviction)
  .then(testBaselineValidationAndMonotonicOrdering)
  .then(testGenerationDisposalAndNormalizationSafety)
  .then(testStaleGenerationCannotSupersedeQueuedEdit)
  .then(testOldGenerationEditSurvivesInitDeliveryGap)
  .then(testInFlightOldGenerationEditRefreshesPromotedRenderer)
  .then(testPendingInitPinsOriginAcrossHistoryEviction)
  .then(testRepeatedInitializationIsSerialized)
  .then(testInitializationRetryAfterFalseDelivery)
  .then(testInitializationRetryAfterRejectedDelivery)
  .then(() => testEditAcknowledgementRetriesBeforeUpdate('false'))
  .then(() => testEditAcknowledgementRetriesBeforeUpdate('reject'))
  .then(testSaveContinuesAfterAcknowledgementRejection)
  .then(testStaleHostSnapshotIsDiscardedAfterNewEditorEdit)
  .then(testConcurrentHostUpdatesAreCoalesced)
  .then(testQueuedEditsAreCoalesced)
  .then(testVersionHistoryHasABoundedMemoryBudget)
  .then(() => console.log('webview controller synchronization tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
