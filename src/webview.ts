import * as vscode from 'vscode'
import * as NodePath from 'path'
import { randomBytes } from 'crypto'
import { applyEol, documentEol, toLf } from './eol'
import { showError } from './notifications'
import { getWorkspaceStyle, WorkspaceStyle } from './workspace-style'
import {
  computeMinimalTextEdit,
  mergeThreeWayTextPreferringLocal,
  reconcileCanonicalisedEdit,
} from './text-sync'

export const KeyVditorOptions = 'vditor.options'

export type WebviewTheme = 'dark' | 'light'

export interface WebviewUpdate {
  type?: 'init' | 'update'
  options?: any
  theme?: WebviewTheme
  workspaceStyleCss?: string | null
  workspaceStylePath?: string | null
  editorGeneration?: number
}

export interface WebviewUploadFile {
  base64: string
  mime?: string
  name: string
  size?: number
}

interface VersionedWebviewEdit {
  content: string
  seq: number
  baseVersion: number
  generation: number
}

interface EditorBaselineMessage {
  command: 'editor-baseline'
  content: string
  documentVersion: number
  generation: number
  projectionSerial: number
}

export type WebviewMessage =
  | { command: 'ready' }
  | { command: 'save-options'; options: any }
  | { command: 'scroll'; top?: number }
  | { command: 'info'; content: string }
  | { command: 'error'; content: string }
  | EditorBaselineMessage
  | ({ command: 'edit' } & VersionedWebviewEdit)
  | ({ command: 'reset-config' } & VersionedWebviewEdit)
  | ({ command: 'normalize-formatting' } & VersionedWebviewEdit)
  | { command: 'reload-workspace-style' }
  | ({ command: 'save' } & VersionedWebviewEdit)
  | { command: 'upload'; files: WebviewUploadFile[] }
  | { command: 'open-link'; href: string }

export interface MarkdownDocumentSnapshot {
  content: string
  version: number
}

export interface MarkdownWebviewHost {
  readonly context: vscode.ExtensionContext
  readonly panel: vscode.WebviewPanel
  readonly uri: vscode.Uri
  isDisposed(): boolean
  getSnapshot(): Promise<MarkdownDocumentSnapshot>
  syncToDocument(content: string): Promise<vscode.TextDocument | undefined>
  getAssetsFolder(): string
  openLink(href: string): Promise<void>
  getScrollTop(): number
  saveScrollPosition(top: number): void
}

interface EditFlushResult {
  document?: vscode.TextDocument
  error?: unknown
  ignored?: boolean
}

type VersionedWebviewMessage = Extract<
  WebviewMessage,
  { content: string; seq: number; baseVersion: number }
>

interface QueuedEdit {
  message: VersionedWebviewMessage
  baseline: EditorProjectionBaseline | undefined
  resolve(result: EditFlushResult): void
}

interface AppliedWebviewEdit extends MarkdownDocumentSnapshot {
  seq: number
  sourceContent: string
}

interface EditorProjectionBaseline extends MarkdownDocumentSnapshot {
  generation: number
  origin: string
  projectionSerial: number
  provenance: 'renderer' | 'derived'
}

interface PendingEditorInitialization {
  generation: number
  snapshot?: MarkdownDocumentSnapshot
}

interface EditAcknowledgementMessage {
  command: 'edit-ack'
  seq: number
  documentVersion: number
  content: string
  merged: boolean
  generation: number
}

const MAX_VERSION_HISTORY_ENTRIES = 50
const MAX_VERSION_HISTORY_BYTES = 4 * 1024 * 1024

export const DEFAULT_MAX_UPLOAD_SIZE_MB = 10
export const MAX_UPLOAD_SIZE_MB = 100
export const MAX_UPLOAD_FILE_COUNT = 20

const UPLOAD_FILE_EXTENSIONS: { [mime: string]: string[] } = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'audio/wav': ['.wav'],
  'audio/mpeg': ['.mp3'],
  'audio/ogg': ['.ogg'],
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * Validates a full 4-byte MPEG audio frame header rather than only the 11 sync
 * bits. Checking sync alone accepts any payload starting 0xFF followed by one
 * of 32 second-byte values, which lets arbitrary binary through as audio.
 *
 * MP3 has no magic number, so this narrows the false-positive space by roughly
 * two orders of magnitude but cannot eliminate it: a UTF-16LE text file whose
 * first character happens to encode a legal bitrate/sample-rate pair still
 * passes. The forced `.mp3` extension and the refusal to overwrite an existing
 * target are what bound the impact of a wrong guess.
 */
function isMpegFrameHeader(content: Buffer): boolean {
  if (content.length < 4) return false
  if (content[0] !== 0xff || (content[1] & 0xe0) !== 0xe0) return false
  // 0b01 is a reserved MPEG version and 0b00 a reserved layer.
  if (((content[1] >> 3) & 0x03) === 0x01) return false
  if (((content[1] >> 1) & 0x03) === 0x00) return false
  // 0b1111 is the invalid bitrate index, 0b11 the reserved sample-rate index.
  if (((content[2] >> 4) & 0x0f) === 0x0f) return false
  if (((content[2] >> 2) & 0x03) === 0x03) return false
  return true
}

// Windows and macOS default to case-insensitive filesystems, so `Photo.mp3`
// and `photo.mp3` in one batch are the same file. Fold case only there: on
// Linux the two really are distinct and must both be allowed to land.
const CASE_INSENSITIVE_FS =
  process.platform === 'win32' || process.platform === 'darwin'

function uploadTargetKey(target: string): string {
  return CASE_INSENSITIVE_FS ? target.toLowerCase() : target
}

async function uploadTargetExists(target: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(target))
    return true
  } catch {
    return false
  }
}

function normalizeUploadMime(value: string | undefined): string | undefined {
  if (!value) return undefined
  const mime = value.split(';', 1)[0].trim().toLowerCase()
  const aliases: { [mime: string]: string } = {
    'audio/mp3': 'audio/mpeg',
    'audio/x-mpeg': 'audio/mpeg',
    'audio/x-ogg': 'audio/ogg',
    'audio/x-wav': 'audio/wav',
    'application/ogg': 'audio/ogg',
    'image/jpg': 'image/jpeg',
    'image/pjpeg': 'image/jpeg',
    'image/x-png': 'image/png',
  }
  return aliases[mime] || mime
}

function bytesMatch(content: Buffer, offset: number, bytes: number[]): boolean {
  return (
    content.length >= offset + bytes.length &&
    bytes.every((value, index) => content[offset + index] === value)
  )
}

function detectUploadMime(content: Buffer): string | undefined {
  if (bytesMatch(content, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png'
  }
  if (bytesMatch(content, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (
    content.toString('ascii', 0, 6) === 'GIF87a' ||
    content.toString('ascii', 0, 6) === 'GIF89a'
  ) {
    return 'image/gif'
  }
  if (
    content.toString('ascii', 0, 4) === 'RIFF' &&
    content.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (
    content.toString('ascii', 0, 4) === 'RIFF' &&
    content.toString('ascii', 8, 12) === 'WAVE'
  ) {
    return 'audio/wav'
  }
  if (content.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg'
  if (content.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg'
  if (isMpegFrameHeader(content)) return 'audio/mpeg'
  return undefined
}

/**
 * Validates and decodes an upload at the extension-host boundary. The webview
 * is renderer code and must not be trusted to supply an accurate MIME type,
 * byte size, or file payload.
 */
export interface ValidatedWebviewUploadFile {
  content: Buffer
  mime: string
  name: string
}

export function validateWebviewUploadFile(
  file: WebviewUploadFile,
  maxBytes: number = DEFAULT_MAX_UPLOAD_SIZE_MB * 1024 * 1024
): ValidatedWebviewUploadFile {
  if (
    !file ||
    typeof file.name !== 'string' ||
    typeof file.base64 !== 'string' ||
    !file.name ||
    file.name === '.' ||
    file.name === '..' ||
    /[\\/]/.test(file.name)
  ) {
    throw new Error('Invalid upload file name')
  }

  const maximumBase64Length = Math.ceil(maxBytes / 3) * 4
  if (
    !file.base64 ||
    file.base64.length > maximumBase64Length ||
    !BASE64_PATTERN.test(file.base64)
  ) {
    throw new Error('Invalid or oversized upload data')
  }

  const content = Buffer.from(file.base64, 'base64')
  if (
    content.length === 0 ||
    content.length > maxBytes ||
    content.toString('base64') !== file.base64
  ) {
    throw new Error('Invalid or oversized upload data')
  }
  if (
    file.size !== undefined &&
    (!Number.isInteger(file.size) || file.size < 0 || file.size !== content.length)
  ) {
    throw new Error('Upload size did not match its payload')
  }

  const detectedMime = detectUploadMime(content)
  if (!detectedMime) throw new Error('Unsupported upload file type')
  const declaredMime = normalizeUploadMime(file.mime)
  if (declaredMime && declaredMime !== detectedMime) {
    throw new Error('Upload MIME type did not match its payload')
  }

  const supportedExtensions = UPLOAD_FILE_EXTENSIONS[detectedMime]
  const extension = NodePath.extname(file.name).toLowerCase()
  if (extension && supportedExtensions.indexOf(extension) === -1) {
    throw new Error('Upload file extension did not match its payload')
  }

  return {
    content,
    mime: detectedMime,
    // Clipboard File objects are permitted to omit a filename. Add the suffix
    // only after inspecting the payload, never based on the claimed MIME type.
    name: extension ? file.name : `${file.name}${supportedExtensions[0]}`,
  }
}

export function getUploadMaxBytes(uri: vscode.Uri): number {
  const configured = vscode.workspace
    .getConfiguration('markdown-interactor', uri)
    .get<number>('maxUploadSizeMB')
  const megabytes =
    typeof configured === 'number' && Number.isFinite(configured)
      ? Math.min(MAX_UPLOAD_SIZE_MB, Math.max(1, configured))
      : DEFAULT_MAX_UPLOAD_SIZE_MB
  return Math.floor(megabytes * 1024 * 1024)
}

export async function applyMinimalDocumentEdit(
  document: vscode.TextDocument,
  content: string
): Promise<vscode.TextDocument> {
  const current = document.getText()
  const desired = applyEol(content, documentEol(document))
  const change = computeMinimalTextEdit(current, desired)
  if (!change) return document

  const edit = new vscode.WorkspaceEdit()
  edit.replace(
    document.uri,
    new vscode.Range(
      document.positionAt(change.start),
      document.positionAt(change.end)
    ),
    change.text
  )
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error(`VS Code rejected the Markdown document edit`)
  }
  return document
}

export function getWebviewOptions(
  context: vscode.ExtensionContext,
  uri?: vscode.Uri
): vscode.WebviewOptions & vscode.WebviewPanelOptions {
  const roots = [
    context.extensionUri,
    ...(vscode.workspace.workspaceFolders || []).map((folder) => folder.uri),
    ...(uri ? [vscode.Uri.joinPath(uri, '..')] : []),
    ...(uri ? [vscode.Uri.file(getAssetsFolder(uri))] : []),
  ]
  const uniqueRoots = Array.from(
    new Map(roots.map((root) => [root.toString(), root])).values()
  )

  return {
    // Enable javascript in the webview
    enableScripts: true,
    localResourceRoots: uniqueRoots,
    retainContextWhenHidden: true,
    enableCommandUris: false,
    enableFindWidget: true,
  }
}

export function getWebviewTheme(): WebviewTheme {
  return vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast
    ? 'dark'
    : 'light'
}

/**
 * Builds initial Vditor options from VS Code settings and saved options.
 *
 * Theme and preview choices from older versions are deliberately ignored.
 * Split preview is fixed by the webview whenever SV edit mode is selected.
 */
export function getVditorOptions(
  context: vscode.ExtensionContext,
  uri?: vscode.Uri
): any {
  const config = vscode.workspace.getConfiguration('markdown-interactor', uri)
  const savedOptions = context.globalState.get<any>(KeyVditorOptions) || {}
  const {
    theme: _theme,
    preview: _preview,
    // Dropped for the same reason as theme and preview: this is the extension's
    // own setting, not one of Vditor's, so a value left in saved editor state
    // must not be able to reach the webview unvalidated.
    frontMatterDisplay: _frontMatterDisplay,
    ...editorOptions
  } = savedOptions

  return {
    useVscodeThemeColor: config.get<boolean>('useVscodeThemeColor'),
    ...editorOptions,
    frontMatterDisplay: getFrontMatterDisplay(config),
  }
}

const FRONT_MATTER_DISPLAY_MODES = ['table', 'codeBlock', 'hide'] as const

/**
 * Reads the plugin's own front matter setting. Deliberately not derived from
 * `markdown.preview.frontMatter`: that governs VS Code's preview, not this
 * editor, and a hand-edited settings.json can hold anything, so an unknown value
 * falls back to the default rather than reaching the webview.
 */
function getFrontMatterDisplay(
  config: vscode.WorkspaceConfiguration
): (typeof FRONT_MATTER_DISPLAY_MODES)[number] {
  const value = config.get<string>('frontMatterDisplay')
  return FRONT_MATTER_DISPLAY_MODES.includes(value as any)
    ? (value as (typeof FRONT_MATTER_DISPLAY_MODES)[number])
    : 'table'
}

export function isRemoteMediaAllowed(uri: vscode.Uri): boolean {
  return (
    vscode.workspace
      .getConfiguration('markdown-interactor', uri)
      .get<boolean>('allowRemoteMedia') !== false
  )
}

export function getAssetsFolder(uri: vscode.Uri): string {
  const config = vscode.workspace.getConfiguration('markdown-interactor', uri)
  const imageSaveFolder = (config.get<string>('imageSaveFolder') || 'assets')
    .replace(
      '${projectRoot}',
      vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath || ''
    )
    .replace('${file}', uri.fsPath)
    .replace(
      '${fileBasenameNoExtension}',
      NodePath.basename(uri.fsPath, NodePath.extname(uri.fsPath))
    )
    .replace('${dir}', NodePath.dirname(uri.fsPath))
  return NodePath.resolve(NodePath.dirname(uri.fsPath), imageSaveFolder)
}

/**
 * Hides #app until the external stylesheet and Vditor have both finished
 * loading. The ready attribute is set by media-src/src/main.ts.
 */
export const appVisibilityCss =
  '#app{opacity:0}body[data-vmd-ready="1"][data-vmd-css-loaded="1"] #app{opacity:1}'

export function getWebviewHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  uri: vscode.Uri
): string {
  const nonce = randomBytes(16).toString('base64')
  const toUri = (file: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, file))
  const baseHref =
    NodePath.dirname(
      webview.asWebviewUri(vscode.Uri.file(uri.fsPath)).toString()
    ) + '/'
  const toMediaPath = (file: string) => `media/dist/${file}`
  const jsFiles = ['main.js'].map(toMediaPath).map(toUri)
  const cssFiles = ['main.css'].map(toMediaPath).map(toUri)
  const allowRemoteMedia = isRemoteMediaAllowed(uri)
  const remoteMediaSource = allowRemoteMedia ? ' https:' : ''
  // Only img-src and media-src are gated on the setting, because those are the
  // only directives the document's own content drives. The `https:` elsewhere is
  // load-bearing for the renderers Vditor fetches from its CDN the first time a
  // document needs one (highlight.js, KaTeX, Mermaid and friends); dropping it
  // would silently break those block types rather than harden the editor. The
  // parser and locale bundles it needs at startup are bundled into media/dist,
  // so bringing the editor up requests nothing over the network.
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource}${remoteMediaSource} data: blob:`,
    `media-src ${webview.cspSource}${remoteMediaSource} data: blob:`,
    `font-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} https: 'unsafe-inline'`,
    `script-src ${webview.cspSource} https: 'nonce-${nonce}' 'unsafe-eval'`,
    `connect-src ${webview.cspSource} https:`,
    `worker-src blob:`,
  ].join('; ')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <base href="${baseHref}" />
  <style>${appVisibilityCss}</style>
  ${cssFiles
    .map((file, index) =>
      `<link id="vmd-style-${index}" href="${file}" rel="stylesheet">`
    )
    .join('\n')}
  <title>Markdown Interactor</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">
    (() => {
      const styles = Array.from(document.querySelectorAll('link[id^="vmd-style-"]'));
      let remaining = styles.length;
      const done = () => {
        remaining -= 1;
        if (remaining <= 0) document.body.setAttribute('data-vmd-css-loaded', '1');
      };
      if (remaining === 0) document.body.setAttribute('data-vmd-css-loaded', '1');
      styles.forEach((style) => {
        if (style.sheet) done();
        else {
          style.addEventListener('load', done, { once: true });
          style.addEventListener('error', done, { once: true });
        }
      });
    })();
  </script>
  ${jsFiles
    .map((file) => `<script nonce="${nonce}" src="${file}"></script>`)
    .join('\n')}
</body>
</html>`
}

export class MarkdownWebviewController implements vscode.Disposable {
  private disposed = false
  private workspaceStyle: WorkspaceStyle | undefined
  private readonly messageDisposable: vscode.Disposable
  private readonly editQueue: QueuedEdit[] = []
  private editFlushPromise: Promise<EditFlushResult> | undefined
  private updatePromise: Promise<void> | undefined
  private updateRequested = false
  private editEpoch = 0
  private expectedDocumentContent: string | undefined
  private lastPostedSnapshot: MarkdownDocumentSnapshot | undefined
  private lastAppliedWebviewEdit: AppliedWebviewEdit | undefined
  private readonly versionHistory = new Map<number, string>()
  private versionHistoryBytes = 0
  private editorGeneration = 0
  private editorGenerationSerial = 0
  private pendingInitialization: PendingEditorInitialization | undefined
  private reinitializeRequested = false
  private editorBaseline: EditorProjectionBaseline | undefined
  private pendingEditAcknowledgement: EditAcknowledgementMessage | undefined
  private editAcknowledgementDelivery: Promise<void> | undefined

  constructor(private readonly host: MarkdownWebviewHost) {
    this.messageDisposable = host.panel.webview.onDidReceiveMessage(
      (message) => {
        void this.handleMessage(message as WebviewMessage)
      }
    )
  }

  public update(props: WebviewUpdate = {}): Promise<void> {
    if (this.disposed || this.host.isDisposed()) return Promise.resolve()

    // Initialization has its own payload and must never be coalesced with an
    // ordinary document update.
    if (props.type === 'init') {
      return this.performUpdate(props, false)
    }

    if (this.updatePromise) {
      this.updateRequested = true
      return this.updatePromise
    }

    const update = this.performUpdate(props, true)
    this.updatePromise = update
    void update
      .finally(() => {
        if (this.updatePromise !== update) return
        this.updatePromise = undefined
        if (!this.updateRequested || this.disposed || this.host.isDisposed()) {
          this.updateRequested = false
          return
        }
        this.updateRequested = false
        void this.update().catch((error) => {
          if (!this.disposed && !this.host.isDisposed()) console.error(error)
        })
      })
      .catch(() => {
        // The original update promise is returned to the caller for reporting.
      })
    return update
  }

  private async performUpdate(
    props: WebviewUpdate,
    discardIfNewerEdit: boolean
  ): Promise<void> {
    const editEpoch = this.editEpoch
    const editorGeneration =
      props.editorGeneration === undefined
        ? this.editorGeneration
        : props.editorGeneration

    // Document-originated updates must wait for already-received webview edits.
    // Otherwise an older external snapshot can arrive in the webview after a newer
    // edit was applied, leaving the two sides out of sync.
    if (this.editFlushPromise) {
      await this.editFlushPromise
    }
    if (this.pendingEditAcknowledgement || this.editAcknowledgementDelivery) {
      await this.deliverPendingEditAcknowledgement()
    }
    if (
      this.disposed ||
      this.host.isDisposed() ||
      !this.isUpdateGenerationValid(editorGeneration, props.type) ||
      (discardIfNewerEdit && this.editEpoch !== editEpoch)
    ) {
      return
    }

    const hostSnapshot = await this.host.getSnapshot()
    const snapshot = {
      ...hostSnapshot,
      content: toLf(hostSnapshot.content),
    }
    if (
      this.disposed ||
      this.host.isDisposed() ||
      !this.isUpdateGenerationValid(editorGeneration, props.type) ||
      (discardIfNewerEdit && this.editEpoch !== editEpoch)
    ) {
      return
    }
    this.rememberSnapshot(snapshot)

    if (
      props.type !== 'init' &&
      ((this.lastPostedSnapshot &&
        snapshot.content === this.lastPostedSnapshot.content &&
        snapshot.version === this.lastPostedSnapshot.version) ||
        (this.lastAppliedWebviewEdit &&
          snapshot.content === this.lastAppliedWebviewEdit.content &&
          snapshot.version === this.lastAppliedWebviewEdit.version))
    ) {
      return
    }

    // A newer local edit may have arrived while getSnapshot() was pending. Do
    // not let this older document snapshot reach the focused webview as an
    // apparent external change.
    if (
      !this.isUpdateGenerationValid(editorGeneration, props.type) ||
      (discardIfNewerEdit && this.editEpoch !== editEpoch)
    ) {
      return
    }

    // Pin the exact init source independently of bounded history and ordinary
    // update deduplication. The renderer's first baseline must pair with this
    // generation/version/content tuple even if a later large edit evicts it.
    if (props.type === 'init') {
      const pending = this.pendingInitialization
      if (!pending || pending.generation !== editorGeneration) return
      pending.snapshot = snapshot
    }

    // Reserve this snapshot before awaiting the webview delivery so concurrent
    // document notifications cannot enqueue the same stale payload twice.
    this.lastPostedSnapshot = snapshot
    let delivered = false
    try {
      delivered = await this.host.panel.webview.postMessage({
        command: 'update',
        content: snapshot.content,
        documentVersion: snapshot.version,
        editorGeneration,
        ...(props.type === 'init'
          ? {
              scrollTop: this.getScrollTop(),
            }
          : {}),
        ...props,
      })
    } finally {
      // postMessage resolves false for a hidden webview and rejects when the
      // panel is disposed mid-await. Release the reservation on both paths:
      // otherwise the webview is treated as already holding this snapshot, the
      // re-post is skipped, and stale content stays on screen.
      if (!delivered && this.lastPostedSnapshot === snapshot) {
        this.lastPostedSnapshot = undefined
      }
      if (!delivered && props.type === 'init') {
        this.releasePendingInitialization(editorGeneration)
      }
    }
  }

  private isUpdateGenerationValid(
    generation: number,
    type: WebviewUpdate['type']
  ): boolean {
    return (
      generation === this.editorGeneration ||
      (type === 'init' &&
        generation === this.pendingInitialization?.generation)
    )
  }

  private scheduleRequestedInitialization(): void {
    if (
      !this.reinitializeRequested ||
      this.pendingInitialization ||
      this.disposed ||
      this.host.isDisposed()
    ) {
      return
    }
    this.reinitializeRequested = false
    void Promise.resolve()
      .then(() => this.initialize())
      .catch((error) => {
        if (!this.disposed && !this.host.isDisposed()) console.error(error)
      })
  }

  private releasePendingInitialization(generation: number): void {
    if (this.pendingInitialization?.generation !== generation) return
    this.pendingInitialization = undefined
    this.scheduleRequestedInitialization()
  }

  public async initialize(): Promise<void> {
    if (this.disposed || this.host.isDisposed()) return
    if (this.pendingInitialization) {
      this.reinitializeRequested = true
      return
    }

    // Resolve the project stylesheet once per webview. It is deliberately not
    // watched; users can explicitly reload it from the editor's More menu.
    if (this.workspaceStyle === undefined) {
      this.workspaceStyle = await getWorkspaceStyle(this.host.uri)
    }
    if (this.disposed || this.host.isDisposed()) return
    if (this.pendingInitialization) {
      this.reinitializeRequested = true
      return
    }

    // Keep the visible renderer active while its replacement init is in
    // transit. Generation IDs are never reused after failed delivery, so a
    // delayed callback from an abandoned renderer cannot promote a retry.
    const editorGeneration = Math.max(
      this.editorGeneration,
      this.editorGenerationSerial
    ) + 1
    this.editorGenerationSerial = editorGeneration
    this.pendingInitialization = { generation: editorGeneration }

    try {
      await this.update({
        type: 'init',
        options: getVditorOptions(this.host.context, this.host.uri),
        theme: getWebviewTheme(),
        workspaceStyleCss: this.workspaceStyle.css,
        workspaceStylePath: this.workspaceStyle.path,
        editorGeneration,
      })
    } catch (error) {
      // getSnapshot() can fail before postMessage's delivery-finally runs.
      this.releasePendingInitialization(editorGeneration)
      throw error
    }
  }

  public async updateTheme(): Promise<void> {
    if (this.disposed || this.host.isDisposed()) return
    await this.host.panel.webview.postMessage({
      command: 'theme',
      theme: getWebviewTheme(),
    })
  }

  private async reloadWorkspaceStyle(): Promise<void> {
    // Read the file contents again instead of relying on a webview resource URL.
    // This avoids Chromium/VS Code resource caching and makes a manual refresh
    // deterministic even when the file was created after the panel opened.
    this.workspaceStyle = await getWorkspaceStyle(this.host.uri)
    if (this.disposed || this.host.isDisposed()) return

    await this.host.panel.webview.postMessage({
      command: 'workspace-style',
      css: this.workspaceStyle.css,
      path: this.workspaceStyle.path,
    })
  }

  private getScrollTop(): number {
    // The host stores scroll positions by document URI. Keeping this callback
    // on the host means the shared controller does not own document state.
    return this.host.getScrollTop()
  }

  private rememberSnapshot(snapshot: MarkdownDocumentSnapshot): void {
    const previous = this.versionHistory.get(snapshot.version)
    if (previous !== undefined) {
      this.versionHistoryBytes -= previous.length * 2
    }
    this.versionHistory.set(snapshot.version, snapshot.content)
    this.versionHistoryBytes += snapshot.content.length * 2

    // Keep the newest snapshot even when one document alone exceeds the
    // budget: it is still the best possible merge base, but never retain a
    // rolling sequence of large full-document copies. The active editor
    // baseline pins its own origin separately, so history eviction is safe.
    while (
      this.versionHistory.size > 1 &&
      (this.versionHistory.size > MAX_VERSION_HISTORY_ENTRIES ||
        this.versionHistoryBytes > MAX_VERSION_HISTORY_BYTES)
    ) {
      const oldest = this.versionHistory.keys().next().value
      const content = this.versionHistory.get(oldest)
      this.versionHistory.delete(oldest)
      if (content !== undefined) this.versionHistoryBytes -= content.length * 2
    }
  }

  private installEditorBaseline(candidate: EditorProjectionBaseline): boolean {
    if (
      this.disposed ||
      this.host.isDisposed() ||
      candidate.generation !== this.editorGeneration
    ) {
      return false
    }

    const current = this.editorBaseline
    if (current && candidate.version < current.version) return false
    if (current && candidate.version === current.version) {
      if (candidate.provenance === 'derived') return false
      if (
        current.provenance === 'renderer' &&
        candidate.projectionSerial <= current.projectionSerial
      ) {
        return false
      }
    }

    this.editorBaseline = candidate
    return true
  }

  private acceptEditorBaseline(message: EditorBaselineMessage): void {
    const pending = this.pendingInitialization
    if (
      typeof message.content !== 'string' ||
      !Number.isInteger(message.documentVersion) ||
      message.documentVersion < 0 ||
      !Number.isInteger(message.generation) ||
      (message.generation !== this.editorGeneration &&
        message.generation !== pending?.generation) ||
      !Number.isInteger(message.projectionSerial) ||
      message.projectionSerial < 1
    ) {
      return
    }

    const promoted = message.generation === pending?.generation
    const origin = promoted
      ? pending?.snapshot?.version === message.documentVersion
        ? pending.snapshot.content
        : undefined
      : this.versionHistory.get(message.documentVersion)
    if (origin === undefined) return

    const latestKnownVersion = Array.from(this.versionHistory.keys()).reduce(
      (latest, version) => Math.max(latest, version),
      message.documentVersion
    )
    const refreshAfterPromotion =
      promoted &&
      (!!this.editFlushPromise ||
        latestKnownVersion > message.documentVersion ||
        !this.lastPostedSnapshot ||
        this.lastPostedSnapshot.version !== message.documentVersion ||
        this.lastPostedSnapshot.content !== origin)
    if (promoted) {
      this.editorGeneration = message.generation
      this.pendingInitialization = undefined
      this.editorBaseline = undefined
      this.lastAppliedWebviewEdit = undefined
      if (
        this.pendingEditAcknowledgement &&
        this.pendingEditAcknowledgement.generation !== message.generation
      ) {
        this.pendingEditAcknowledgement = undefined
      }
      if (refreshAfterPromotion) {
        // A snapshot posted to the old generation cannot prove that the new
        // renderer has seen it. Force a latest-source update after promotion.
        this.lastPostedSnapshot = undefined
      }
    }

    this.installEditorBaseline({
      content: toLf(message.content),
      origin,
      version: message.documentVersion,
      generation: message.generation,
      projectionSerial: message.projectionSerial,
      provenance: 'renderer',
    })

    if (refreshAfterPromotion) {
      // Old-renderer edits may have landed while init was in transit. update()
      // waits for the accepted queue before sending the promoted renderer the
      // newest source snapshot.
      void this.update().catch((error) => {
        if (!this.disposed && !this.host.isDisposed()) console.error(error)
      })
    }
    if (promoted) this.scheduleRequestedInitialization()
  }

  /** Records a VS Code document event and returns whether it is our own echo. */
  public observeDocumentChange(document: vscode.TextDocument): boolean {
    const snapshot = {
      content: toLf(document.getText()),
      version: document.version,
    }
    this.rememberSnapshot(snapshot)

    if (snapshot.content === this.expectedDocumentContent) return true

    return !!(
      this.lastAppliedWebviewEdit &&
      snapshot.content === this.lastAppliedWebviewEdit.content &&
      snapshot.version === this.lastAppliedWebviewEdit.version
    )
  }

  private queueEdit(
    message: VersionedWebviewMessage
  ): Promise<EditFlushResult> {
    // Reject stale instances before queue coalescing: an old-generation edit
    // must never supersede a valid edit already queued by the rebuilt Vditor.
    if (message.generation !== this.editorGeneration) {
      return Promise.resolve({ ignored: true })
    }

    // Capture this synchronously, before the async flush begins. Any host
    // update that began before this point must not deliver an older snapshot.
    this.editEpoch += 1
    return new Promise((resolve) => {
      // Full-document edits are superseded by a newer full-document edit until
      // they begin execution. Save/reset messages retain their own queue slot;
      // only ordinary edits are collapsed, and their eventual newer ack clears
      // the corresponding webview sequence entries.
      while (
        this.editQueue.length > 0 &&
        this.editQueue[this.editQueue.length - 1].message.command === 'edit' &&
        this.editQueue[this.editQueue.length - 1].message.generation ===
          message.generation
      ) {
        this.editQueue.pop()!.resolve({})
      }
      this.editQueue.push({
        message: { ...message, content: toLf(message.content) },
        baseline:
          this.editorBaseline?.generation === message.generation
            ? this.editorBaseline
            : undefined,
        resolve,
      })
      if (!this.editFlushPromise) {
        this.editFlushPromise = this.flushEdits()
      }
    })
  }

  private async flushEdits(): Promise<EditFlushResult> {
    let lastResult: EditFlushResult = {}
    try {
      while (
        this.editQueue.length > 0 &&
        !this.disposed &&
        !this.host.isDisposed()
      ) {
        const queued = this.editQueue.shift()!
        try {
          lastResult = await this.applyVersionedEdit(queued)
        } catch (error) {
          lastResult = { error }
          if (!this.disposed && !this.host.isDisposed()) {
            console.error(error)
            showError(`Failed to synchronize the Markdown document`)
          }
        }
        queued.resolve(lastResult)
      }
      return lastResult
    } finally {
      while (this.editQueue.length > 0 && (this.disposed || this.host.isDisposed())) {
        this.editQueue.shift()!.resolve({ error: new Error('Editor disposed') })
      }
      this.editFlushPromise = undefined
    }
  }

  private async applyVersionedEdit(
    queued: QueuedEdit
  ): Promise<EditFlushResult> {
    const { message, baseline } = queued
    if (
      !Number.isInteger(message.seq) ||
      message.seq < 1 ||
      !Number.isInteger(message.baseVersion) ||
      message.baseVersion < 0 ||
      !Number.isInteger(message.generation)
    ) {
      throw new Error('Invalid versioned editor message')
    }

    // queueEdit accepted this generation while it was active and captured the
    // matching immutable projection tuple before any asynchronous work.
    const capturedGeneration = message.generation

    const hostCurrent = await this.host.getSnapshot()
    if (this.disposed || this.host.isDisposed()) {
      return { ignored: true }
    }
    const current = {
      ...hostCurrent,
      content: toLf(hostCurrent.content),
    }
    this.rememberSnapshot(current)

    // First translate the edit from Lute/editor space back into the document's
    // formatting space. The explicit normalization command is the sole bypass.
    let incoming = message.content
    let effectiveBaseVersion = message.baseVersion
    let effectiveBase: string | undefined
    let usedCanonicalReconciliation = false
    if (
      message.command !== 'normalize-formatting' &&
      baseline &&
      baseline.generation === capturedGeneration
    ) {
      incoming = reconcileCanonicalisedEdit(
        baseline.origin,
        baseline.content,
        message.content
      )
      effectiveBaseVersion = baseline.version
      effectiveBase = baseline.origin
      usedCanonicalReconciliation = true
    }

    // Then merge genuine document changes. These two layers intentionally use
    // different bases: editor projection for Lute noise, document history for
    // real concurrent changes.
    let target = incoming
    const lastApplied = this.lastAppliedWebviewEdit
    const isLegacySequentialEdit =
      !usedCanonicalReconciliation &&
      message.command !== 'normalize-formatting' &&
      lastApplied &&
      lastApplied.content === lastApplied.sourceContent &&
      current.content === lastApplied.content &&
      current.version === lastApplied.version &&
      message.seq > lastApplied.seq

    if (
      current.content !== incoming &&
      current.version !== effectiveBaseVersion &&
      !isLegacySequentialEdit
    ) {
      let base = effectiveBase
      if (!usedCanonicalReconciliation) {
        const acknowledgedBase =
          lastApplied &&
          message.seq > lastApplied.seq &&
          message.baseVersion === lastApplied.version
            ? lastApplied.content
            : undefined
        if (message.command === 'normalize-formatting') {
          // Normalization is deliberately document-space-wide. Never use the
          // editor-space sequential source as its external merge base.
          base =
            this.versionHistory.get(message.baseVersion) ?? acknowledgedBase
        } else {
          const sequentialBase =
            lastApplied &&
            message.seq > lastApplied.seq &&
            message.baseVersion < lastApplied.version
              ? lastApplied.sourceContent
              : undefined
          base =
            sequentialBase ??
            this.versionHistory.get(message.baseVersion) ??
            acknowledgedBase
        }
      }

      if (base === undefined) {
        this.reportEditorPreferredMerge(
          'Kept editor content because external changes could not be merged without a base.'
        )
      } else {
        const merge = mergeThreeWayTextPreferringLocal(
          base,
          incoming,
          current.content
        )
        target = merge.content
        if (merge.discardedRemoteChanges.length > 0) {
          this.reportEditorPreferredMerge(
            `Kept editor content for ${merge.discardedRemoteChanges.length} overlapping external change(s).`
          )
        }
      }
    }

    let document: vscode.TextDocument | undefined
    this.expectedDocumentContent = target
    try {
      document = await this.host.syncToDocument(target)
    } finally {
      if (this.expectedDocumentContent === target) {
        this.expectedDocumentContent = undefined
      }
    }

    if (this.disposed || this.host.isDisposed()) {
      return { document, ignored: true }
    }
    const appliedSnapshot = document
      ? { content: document.getText(), version: document.version }
      : await this.host.getSnapshot()
    if (this.disposed || this.host.isDisposed()) {
      return { document, ignored: true }
    }
    const applied = {
      ...appliedSnapshot,
      content: toLf(appliedSnapshot.content),
    }
    this.rememberSnapshot(applied)

    // An edit accepted from the old visible renderer remains authoritative even
    // if the replacement baseline was promoted during an await. Do not install
    // old derived state or send its ack into the new renderer; refresh the new
    // renderer from the source after the queue drains instead.
    if (capturedGeneration !== this.editorGeneration) {
      void this.update().catch((error) => {
        if (!this.disposed && !this.host.isDisposed()) console.error(error)
      })
      return { document }
    }

    this.lastAppliedWebviewEdit = {
      ...applied,
      seq: message.seq,
      // Keep editor-space source for already-posted, pre-ack descendants.
      sourceContent: message.content,
    }

    const editorSpaceAckIsSafe =
      target === incoming && applied.content === incoming
    const acknowledgementContent = editorSpaceAckIsSafe
      ? message.content
      : applied.content
    if (editorSpaceAckIsSafe) {
      this.installEditorBaseline({
        content: message.content,
        origin: applied.content,
        version: applied.version,
        generation: capturedGeneration,
        projectionSerial: 0,
        provenance: 'derived',
      })
    }

    await this.queueEditAcknowledgement({
      command: 'edit-ack',
      seq: message.seq,
      documentVersion: applied.version,
      content: acknowledgementContent,
      merged: acknowledgementContent !== message.content,
      generation: capturedGeneration,
    })
    return { document }
  }

  private async queueEditAcknowledgement(
    acknowledgement: EditAcknowledgementMessage
  ): Promise<void> {
    if (
      this.disposed ||
      this.host.isDisposed() ||
      acknowledgement.generation !== this.editorGeneration
    ) {
      return
    }

    const pending = this.pendingEditAcknowledgement
    if (
      !pending ||
      pending.generation !== acknowledgement.generation ||
      acknowledgement.seq >= pending.seq
    ) {
      // The renderer clears all sent content through the acknowledged sequence,
      // so the newest acknowledgement subsumes older ones in this generation.
      this.pendingEditAcknowledgement = acknowledgement
    }
    await this.deliverPendingEditAcknowledgement()
  }

  private async deliverPendingEditAcknowledgement(): Promise<void> {
    if (this.editAcknowledgementDelivery) {
      await this.editAcknowledgementDelivery
      return
    }

    const acknowledgement = this.pendingEditAcknowledgement
    if (!acknowledgement) return
    if (
      this.disposed ||
      this.host.isDisposed() ||
      acknowledgement.generation !== this.editorGeneration
    ) {
      this.pendingEditAcknowledgement = undefined
      return
    }

    const delivery = (async () => {
      try {
        const delivered = await this.host.panel.webview.postMessage(
          acknowledgement
        )
        if (delivered) {
          if (this.pendingEditAcknowledgement === acknowledgement) {
            this.pendingEditAcknowledgement = undefined
          }
        } else {
          console.warn(
            `[markdown-interactor] edit acknowledgement ${acknowledgement.seq} was not delivered; it will be retried.`
          )
        }
      } catch (error) {
        // The document edit has already succeeded. Keep the acknowledgement in
        // the outbox and retry on the next message/update instead of converting
        // transport failure into a synchronization or save failure.
        console.warn(
          `[markdown-interactor] failed to deliver edit acknowledgement ${acknowledgement.seq}; it will be retried.`,
          error
        )
      }
    })()
    this.editAcknowledgementDelivery = delivery
    try {
      await delivery
    } finally {
      if (this.editAcknowledgementDelivery === delivery) {
        this.editAcknowledgementDelivery = undefined
      }
    }
  }

  private reportEditorPreferredMerge(message: string): void {
    console.warn(`[markdown-interactor] ${message}`)
    vscode.window.setStatusBarMessage(`Markdown Interactor: ${message}`, 5000)
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (this.disposed || this.host.isDisposed()) return

    try {
      if (
        this.pendingEditAcknowledgement ||
        this.editAcknowledgementDelivery
      ) {
        await this.deliverPendingEditAcknowledgement()
        if (this.disposed || this.host.isDisposed()) return
      }
      switch (message.command) {
        case 'ready':
          await this.initialize()
          break
        case 'save-options':
          await this.host.context.globalState.update(
            KeyVditorOptions,
            message.options
          )
          break
        case 'scroll':
          this.host.saveScrollPosition(message.top || 0)
          break
        case 'info':
          vscode.window.showInformationMessage(message.content)
          break
        case 'error':
          showError(message.content)
          break
        case 'editor-baseline':
          this.acceptEditorBaseline(message)
          break
        case 'edit':
          await this.queueEdit(message)
          break
        case 'normalize-formatting': {
          const result = await this.queueEdit(message)
          if (
            result.error ||
            result.ignored ||
            this.disposed ||
            this.host.isDisposed()
          ) {
            return
          }
          vscode.window.showInformationMessage(
            'Markdown formatting normalized successfully.'
          )
          break
        }
        case 'reset-config':
          {
            const result = await this.queueEdit(message)
            if (result.error || result.ignored) return
          }
          await this.host.context.globalState.update(KeyVditorOptions, {})
          await this.initialize()
          if (!this.disposed && !this.host.isDisposed()) {
            vscode.window.showInformationMessage(
              'Reset config successfully!'
            )
          }
          break
        case 'reload-workspace-style':
          await this.reloadWorkspaceStyle()
          break
        case 'save': {
          const result = await this.queueEdit(message)
          if (result.error || result.ignored) return
          const document = result.document
          if (this.disposed || this.host.isDisposed()) return
          if (document) await document.save()
          break
        }
        case 'upload':
          await this.upload(message.files)
          break
        case 'open-link':
          await this.host.openLink(message.href)
          break
      }
    } catch (error) {
      if (!this.disposed && !this.host.isDisposed()) {
        console.error(error)
        showError(`Failed to handle editor message: ${message.command}`)
      }
    }
  }

  private async upload(files: WebviewUploadFile[]): Promise<void> {
    const assetsFolder = this.host.getAssetsFolder()
    if (!Array.isArray(files) || files.length === 0) return
    if (files.length > MAX_UPLOAD_FILE_COUNT) {
      showError(`Upload rejected: at most ${MAX_UPLOAD_FILE_COUNT} files can be added at once`)
      return
    }
    const maxUploadBytes = getUploadMaxBytes(this.host.uri)

    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(assetsFolder))
    } catch (error) {
      console.error(error)
      showError(`Failed to create image folder: ${assetsFolder}`)
      return
    }

    const uploadedFiles: string[] = []
    const failedFiles: string[] = []
    const usedTargets = new Set<string>()
    const root = NodePath.resolve(assetsFolder)

    for (const file of files) {
      try {
        const upload = validateWebviewUploadFile(file, maxUploadBytes)
        const target = NodePath.resolve(root, upload.name)
        const relativeTarget = NodePath.relative(root, target)
        if (
          !relativeTarget ||
          relativeTarget === '..' ||
          relativeTarget.startsWith(`..${NodePath.sep}`) ||
          NodePath.isAbsolute(relativeTarget) ||
          usedTargets.has(uploadTargetKey(target))
        ) {
          throw new Error('Upload target is outside the image folder or duplicated')
        }
        // The webview picks collision-proof names, but it is renderer code and
        // this is the trust boundary: a crafted upload message can name any
        // file with an allowlisted extension, and writeFile would replace it.
        if (await uploadTargetExists(target)) {
          throw new Error(
            `Upload target already exists: ${NodePath.basename(target)}`
          )
        }

        usedTargets.add(uploadTargetKey(target))
        await vscode.workspace.fs.writeFile(vscode.Uri.file(target), upload.content)
        uploadedFiles.push(
          NodePath.relative(NodePath.dirname(this.host.uri.fsPath), target)
            .replace(/\\/g, '/')
        )
      } catch (error) {
        console.error(error)
        failedFiles.push(file?.name || 'unnamed file')
      }
    }

    if (this.disposed || this.host.isDisposed()) return

    if (uploadedFiles.length > 0) {
      await this.host.panel.webview.postMessage({
        command: 'uploaded',
        files: uploadedFiles,
      })
    }
    if (failedFiles.length > 0) {
      showError(`Failed to upload: ${failedFiles.join(', ')}`)
    }
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.editorBaseline = undefined
    this.pendingInitialization = undefined
    this.reinitializeRequested = false
    this.pendingEditAcknowledgement = undefined
    while (this.editQueue.length > 0) {
      this.editQueue.shift()!.resolve({ error: new Error('Editor disposed') })
    }
    this.messageDisposable.dispose()
  }
}
