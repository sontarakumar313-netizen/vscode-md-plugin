import './preload'

// Vditor normally fetches this SVG sprite from its CDN at runtime. Bundle it
// into the webview instead so toolbar and context-menu icons remain available
// when remote scripts are blocked by the webview CSP or the user is offline.
import 'vditor/dist/js/icons/ant.js'

import { fileToBase64, fixLinkClick } from './utils'

import Vditor from 'vditor'
import 'vditor/dist/index.css'
import { captureCaretAnchor, restoreCaretAnchor } from './caret-anchor'
import { lang, t } from './lang'
import {
  installEditorModeShortcutGuard,
  installToolbarSelectionPreserver,
  syncEditorModeToolbar,
  toolbar,
} from './toolbar'
import { initTableContextMenu } from './table-context-menu'
import { initBlockContextMenu } from './block-context-menu'
import {
  closeActiveWysiwygPopover,
  customizeWysiwygPopover,
} from './wysiwyg-popover'
import {
  handleRenderedListTab,
  installWysiwygListCommands,
} from './wysiwyg-list'
import { initWysiwygDetails } from './wysiwyg-details'
import { initWysiwygAlerts } from './wysiwyg-alert'
import { initWysiwygCodeBlocks } from './wysiwyg-code-block'
import { initWysiwygSourceEditors } from './wysiwyg-source-editor'
import { initWysiwygHtmlPresentation } from './wysiwyg-html-presentation'
import { initWysiwygHeadingLevels } from './wysiwyg-heading-level'
import {
  attachFrontMatterSeparator,
  initWysiwygFrontMatter,
} from './wysiwyg-front-matter'
import type { FrontMatterDisplay } from './wysiwyg-front-matter'
import {
  canApplyHostUpdate,
  keepNewestHostUpdate,
} from './host-update-policy'
import {
  getVditorEditorElement,
  getVditorInternals,
  getVditorMode,
} from './vditor-adapter'
import { installStructuredTabPolicy } from './editor-tab-policy'
import { initSplitScrollSync } from './split-scroll-sync'
import { getScrollElement } from './scroll-target'
import { installSvCodeIndentRepair } from './sv-code-indent'
import { formatUploadTimestamp } from './upload-timestamp'
import { installWysiwygSourcePanelAutoClose } from './wysiwyg-source-panel'
import { installToolbarShortcutController } from './toolbar-shortcuts'
import { installEditorClipboard } from './editor-clipboard'
import { vditorI18n } from 'virtual:vditor-i18n'
import './themes/light.css'
import './themes/dark.css'
import './main.css'

// Captured while this script is still executing, because document.currentScript
// is null by the time the host's initialize message arrives. scripts/build-media.mjs
// emits Vditor's parser next to main.js, so its siblings resolve from this URL.
const mediaScriptUrl =
  (document.currentScript as HTMLScriptElement | null)?.src ||
  (document.querySelector('script[src$="main.js"]') as HTMLScriptElement | null)
    ?.src ||
  ''

/**
 * URL of a Vditor runtime asset bundled into media/dist, or an empty string when
 * the script URL is unavailable. Empty is deliberate: every Vditor option this
 * feeds treats a falsy value as "fall back to the CDN".
 */
function localVditorAsset(file: string): string {
  if (!mediaScriptUrl) return ''
  try {
    return new URL(file, mediaScriptUrl).toString()
  } catch {
    return ''
  }
}

/**
 * Vditor's code renderer creates its copy control with an inline onclick
 * attribute. The extension webview CSP intentionally blocks inline handlers,
 * so delegate the action here instead of changing Vditor's generated DOM or
 * relaxing the CSP.
 */
function installCodeCopyHandler(): { dispose(): void } {
  const feedbackTimers = new WeakMap<HTMLElement, number>()
  const activeTimers = new Set<number>()
  let disposed = false

  const copyLabel = (copied: boolean): string => {
    const i18n = (window as Window & { VditorI18n?: unknown }).VditorI18n
    if (!i18n || typeof i18n !== 'object') {
      return copied ? 'Copied' : 'Copy'
    }
    const key = copied ? 'copied' : 'copy'
    const value = (i18n as Record<string, unknown>)[key]
    const fallback = copied ? 'Copied' : 'Copy'
    return typeof value === 'string' && value.trim() ? value : fallback
  }

  const showCopyFeedback = (
    button: HTMLElement,
    label: string,
    copied: boolean
  ): void => {
    if (disposed || !button.isConnected) return
    const pending = feedbackTimers.get(button)
    if (pending !== undefined) {
      window.clearTimeout(pending)
      activeTimers.delete(pending)
    }

    let feedback = button.querySelector<HTMLElement>(
      ':scope > .vmd-code-copy-feedback'
    )
    if (!feedback) {
      feedback = document.createElement('b')
      feedback.className = 'vmd-code-copy-feedback'
      feedback.setAttribute('aria-hidden', 'true')
      button.appendChild(feedback)
    }
    feedback.textContent = `${copied ? '✓' : '!'} ${label}`
    button.setAttribute('aria-label', label)
    button.classList.remove('vditor-tooltipped--hover')
    button.classList.add('vmd-code-copy--feedback')
    button.classList.toggle('vmd-code-copy--success', copied)
    button.classList.toggle('vmd-code-copy--failed', !copied)

    const timer = window.setTimeout(() => {
      activeTimers.delete(timer)
      feedbackTimers.delete(button)
      if (!button.isConnected) return
      button.classList.remove(
        'vmd-code-copy--feedback',
        'vmd-code-copy--success',
        'vmd-code-copy--failed'
      )
      feedback.remove()
      button.setAttribute('aria-label', copyLabel(false))
    }, 1500)
    activeTimers.add(timer)
    feedbackTimers.set(button, timer)
  }

  const showCopiedFeedback = (button: HTMLElement): void => {
    showCopyFeedback(button, copyLabel(true), true)
  }

  const showCopyFailedFeedback = (button: HTMLElement): void => {
    showCopyFeedback(button, t('copyFailed'), false)
  }

  const handleClick = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest<HTMLElement>(
      '.vditor-copy .vditor-tooltipped'
    )
    if (!button) return

    const textarea = button.previousElementSibling
    if (!(textarea instanceof HTMLTextAreaElement)) return

    // Run in the capture phase so the CSP-blocked inline handler never gets
    // a chance to swallow the click without copying anything.
    event.preventDefault()
    event.stopPropagation()
    textarea.focus()
    textarea.select()

    let copied = false
    try {
      copied = document.execCommand('copy')
    } catch (_) {
      copied = false
    }
    textarea.blur()

    if (copied) {
      showCopiedFeedback(button)
      return
    }

    // execCommand is the most compatible path for a click gesture, but some
    // webview hosts disable it. Use the asynchronous Clipboard API as a
    // fallback when the host exposes it.
    const writeText = navigator.clipboard?.writeText
    if (!writeText) {
      showCopyFailedFeedback(button)
      return
    }
    void writeText.call(navigator.clipboard, textarea.value).then(
      () => showCopiedFeedback(button),
      () => showCopyFailedFeedback(button)
    )
  }

  document.addEventListener('click', handleClick, true)
  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      document.removeEventListener('click', handleClick, true)
      activeTimers.forEach((timer) => window.clearTimeout(timer))
      activeTimers.clear()
    },
  }
}

installStructuredTabPolicy()
// Register before the private Vditor heading/mode guard. Configured shortcuts
// are consumed here; unconfigured private combinations fall through to the
// guard and cannot reactivate Vditor's hidden shortcut paths.
const toolbarShortcutController = installToolbarShortcutController()
installEditorModeShortcutGuard()
const editorClipboardController = installEditorClipboard()
const codeCopyController = installCodeCopyHandler()
window.addEventListener(
  'pagehide',
  () => {
    toolbarShortcutController.dispose()
    editorClipboardController.dispose()
    codeCopyController.dispose()
    window.__vmdHeadingLevels?.dispose()
  },
  { once: true }
)
installWysiwygSourcePanelAutoClose()

// Reports the current scroll position to the extension host so it can be restored
// later. This matters because the extension host disposes and recreates the whole
// webview whenever a different file is opened (single shared panel / re-resolved
// custom editor), which would otherwise reset the reading position back to the top
// every time you switch files.
//
// Coordinates with restoreScrollPosition() below via a small shared record (rather
// than a simple boolean "restoring" flag): a scroll event whose resulting position
// exactly matches what the restore just programmatically applied is our own echo and
// is ignored; any OTHER position is genuine external input (user or otherwise) and
// must always be reported immediately, even while a restore is still in flight - and
// it also cancels that in-flight restore so the two stop fighting each other.
const vmdRestoreState: { activeCancel: (() => void) | null; lastApplied: number | null } = {
  activeCancel: null,
  lastApplied: null,
}

function trackScrollPosition() {
  document.addEventListener(
    'scroll',
    () => {
      const el = getScrollElement()
      if (!el) return
      if (vmdRestoreState.activeCancel) {
        if (el.scrollTop === vmdRestoreState.lastApplied) {
          // Our own restore just set this value; not a real user scroll.
          return
        }
        vmdRestoreState.activeCancel()
      }
      // Send synchronously on every scroll event, with no debounce/rAF buffering:
      // switching to a different file disposes this webview entirely (it is not
      // merely hidden), so any deferred reporting risks losing the very last
      // position if the switch happens before the timer/frame callback fires.
      vscode.postMessage({ command: 'scroll', top: el.scrollTop })
    },
    true
  )
}

trackScrollPosition()

function restoreScrollPosition(scrollTop: number) {
  vmdRestoreState.activeCancel?.()
  if (!scrollTop) return
  const el = getScrollElement()
  if (!el) return
  let userScrolled = false
  let done = false

  const apply = () => {
    if (userScrolled || done) return
    el.scrollTop = scrollTop
    vmdRestoreState.lastApplied = scrollTop
  }

  // Large documents keep resizing well past a few hundred milliseconds: mermaid
  // diagrams, tables, and images all finish laying out asynchronously, each shift
  // above the fold moves scrollTop (via Chrome's scroll-anchoring) away from the
  // restored position. Instead of giving up after a short fixed window, keep polling
  // scrollHeight and reapplying until it has been stable for a while, capped at a
  // generous hard timeout so this can't run forever.
  const POLL_MS = 150
  const SETTLE_AFTER_MS = 1200
  const HARD_CAP_MS = 20000
  const startedAt = Date.now()
  let lastHeight = el.scrollHeight
  let lastChangedAt = startedAt

  const cancel = () => {
    if (userScrolled) return
    userScrolled = true
    finish()
  }

  const finish = () => {
    if (done) return
    done = true
    clearInterval(pollTimer)
    if (vmdRestoreState.activeCancel === cancel) {
      vmdRestoreState.activeCancel = null
      vmdRestoreState.lastApplied = null
    }
  }

  // Register with the coordinator BEFORE the first apply(), so trackScrollPosition
  // never observes a scroll position we just set without also seeing activeCancel.
  vmdRestoreState.activeCancel = cancel
  apply()

  const pollTimer = setInterval(() => {
    if (userScrolled) {
      finish()
      return
    }
    const now = Date.now()
    const h = el.scrollHeight
    if (h !== lastHeight) {
      lastHeight = h
      lastChangedAt = now
      apply()
    }
    if (now - lastChangedAt >= SETTLE_AFTER_MS) {
      finish()
    } else if (now - startedAt >= HARD_CAP_MS) {
      finish()
    }
  }, POLL_MS)
}

const WORKSPACE_STYLE_ID = 'vmd-workspace-style'
let vmdIsComposing = false
let vmdWebviewHasFocus = document.hasFocus()
let lastPostedEditorContent: string | null = null
let acknowledgedDocumentVersion = 0
let editorGeneration = 0
let projectionSerial = 0
let nextEditSequence = 1
const sentEditorContent = new Map<number, string>()
const EDIT_SYNC_DELAY_MS = 75
let editorSyncTimer: ReturnType<typeof setTimeout> | null = null
let editorSyncPending = false

interface HostDocumentSnapshot {
  content: string
  documentVersion: number
}

let deferredHostSnapshot: HostDocumentSnapshot | null = null

type BuiltInThemeName = 'light' | 'dark'

const BUILT_IN_THEMES = {
  light: {
    editor: 'classic',
    preview: 'light',
    code: 'github',
  },
  dark: {
    editor: 'dark',
    preview: 'dark',
    code: 'github-dark',
  },
} as const

function setBuiltInTheme(theme: unknown): BuiltInThemeName {
  const name: BuiltInThemeName = theme === 'dark' ? 'dark' : 'light'
  document.body.setAttribute('data-vmd-theme', name)
  return name
}

function updateBuiltInTheme(theme: unknown): void {
  const builtInTheme = BUILT_IN_THEMES[setBuiltInTheme(theme)]
  if (!window.vditor) return
  // setTheme only changes theme classes/styles. Unlike re-initializing Vditor,
  // it does not replace the editable document DOM or invalidate the selection.
  vditor.setTheme(
    builtInTheme.editor,
    builtInTheme.preview,
    builtInTheme.code,
    ''
  )
}

function applyWorkspaceStyle(css: string | null): void {
  let style = document.getElementById(WORKSPACE_STYLE_ID) as HTMLStyleElement | null
  if (css === null) {
    style?.remove()
    document.body.removeAttribute('data-vmd-workspace-style-loaded')
    return
  }

  if (!style) {
    style = document.createElement('style')
    style.id = WORKSPACE_STYLE_ID
    document.head.appendChild(style)
  }
  // textContent is both immediate and safe for arbitrary CSS text. In particular,
  // it bypasses the webview-resource cache that can leave a refreshed <link>
  // reporting success while still exposing the previous stylesheet contents.
  style.textContent = css
  document.body.setAttribute('data-vmd-workspace-style-loaded', '1')
}

/**
 * Whether the editor is already showing this document text.
 *
 * Vditor always reports a trailing newline from getValue(), so comparing raw
 * strings reports a difference for any document that does not end in one. A
 * brand-new blank file is the worst case: the host holds "" forever while the
 * editor holds "\n", so every unchanged host snapshot looked like an external
 * change and raised the reload notice. Only trailing newlines are ignored;
 * trimming further would hide real leading-whitespace edits.
 */
function isSameDocumentText(left: string, right: string): boolean {
  const comparable = (value: string) =>
    value.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  return comparable(left) === comparable(right)
}

function postEditorBaseline(
  content: string,
  documentVersion: number,
  generation = editorGeneration
): void {
  if (
    generation !== editorGeneration ||
    !Number.isInteger(documentVersion) ||
    documentVersion < 0
  ) {
    return
  }
  projectionSerial += 1
  vscode.postMessage({
    command: 'editor-baseline',
    content,
    documentVersion,
    generation,
    projectionSerial,
  })
}

function applyDocumentContent(
  content: string,
  documentVersion: number
): void {
  if (isSameDocumentText(vditor.getValue(), content)) {
    // Deliberately the editor's own text, not the host's. They can differ by a
    // trailing newline here, and recording the host's shorter value would make
    // the next sync post that newline back as an edit, marking a clean file dirty.
    lastPostedEditorContent = vditor.getValue()
    postEditorBaseline(lastPostedEditorContent, documentVersion)
    return
  }

  const editorRoot = getVditorEditorElement(vditor)
  const activeElement = document.activeElement
  const caretAnchor =
    vmdWebviewHasFocus &&
    !!editorRoot &&
    !!activeElement &&
    (activeElement === editorRoot || editorRoot.contains(activeElement))
      ? captureCaretAnchor(vditor)
      : null
  const scrollTop = getScrollElement()?.scrollTop || 0
  vditor.setValue(content)
  if (caretAnchor) restoreCaretAnchor(caretAnchor, vditor)
  restoreScrollPosition(scrollTop)
  lastPostedEditorContent = vditor.getValue()
  postEditorBaseline(lastPostedEditorContent, documentVersion)
}

function currentHostUpdateSafetyState() {
  return {
    isComposing: vmdIsComposing,
    pendingEditCount:
      sentEditorContent.size + (editorSyncPending ? 1 : 0),
  }
}

function deferHostSnapshot(snapshot: HostDocumentSnapshot): void {
  deferredHostSnapshot = keepNewestHostUpdate(
    deferredHostSnapshot,
    snapshot
  )
}

function acceptHostSnapshot(snapshot: HostDocumentSnapshot): boolean {
  if (snapshot.documentVersion < acknowledgedDocumentVersion) return true
  const contentAlreadyLoaded = isSameDocumentText(
    vditor.getValue(),
    snapshot.content
  )
  if (
    !contentAlreadyLoaded &&
    !canApplyHostUpdate(currentHostUpdateSafetyState())
  ) {
    deferHostSnapshot(snapshot)
    return false
  }

  applyDocumentContent(snapshot.content, snapshot.documentVersion)
  acknowledgedDocumentVersion = snapshot.documentVersion
  if (
    deferredHostSnapshot &&
    deferredHostSnapshot.documentVersion <= snapshot.documentVersion
  ) {
    deferredHostSnapshot = null
  }
  return true
}

function flushDeferredHostSnapshot(): void {
  if (!deferredHostSnapshot) return
  const snapshot = deferredHostSnapshot
  if (snapshot.documentVersion <= acknowledgedDocumentVersion) {
    deferredHostSnapshot = null
    return
  }
  deferredHostSnapshot = null
  acceptHostSnapshot(snapshot)
}

type VersionedDocumentCommand =
  | 'edit'
  | 'save'
  | 'reset-config'
  | 'normalize-formatting'

function clearScheduledEditorSync(): void {
  if (editorSyncTimer === null) return
  clearTimeout(editorSyncTimer)
  editorSyncTimer = null
}

function postVersionedDocumentCommand(
  command: VersionedDocumentCommand,
  content = vditor.getValue()
): number {
  clearScheduledEditorSync()
  editorSyncPending = false
  const seq = nextEditSequence
  nextEditSequence += 1
  sentEditorContent.set(seq, content)
  lastPostedEditorContent = content
  vscode.postMessage({
    command,
    content,
    seq,
    baseVersion: acknowledgedDocumentVersion,
    generation: editorGeneration,
  })
  return seq
}

;(window as any).__vmdPostDocumentCommand = postVersionedDocumentCommand

function postEditorContent(): void {
  if (!window.vditor) {
    editorSyncPending = false
    return
  }
  const content = vditor.getValue()
  if (content === lastPostedEditorContent) {
    editorSyncPending = false
    return
  }
  postVersionedDocumentCommand('edit', content)
}

function flushEditorContent(): void {
  clearScheduledEditorSync()
  postEditorContent()
}

function refreshModeDependentFeatures(): void {
  toolbarShortcutController.rebind()
  window.__vmdDetails?.rebind?.()
  window.__vmdAlerts?.rebind?.()
  window.__vmdCodeBlocks?.rebind?.()
  window.__vmdSourceEditors?.rebind?.()
  window.__vmdHtmlPresentation?.rebind?.()
  window.__vmdHeadingLevels?.rebind?.()
  window.__vmdFrontMatter?.rebind?.()
  window.__vmdSplitScrollSync?.rebind?.(window.vditor)
}

window.__vmdBeforeEditorModeChange = () => {
  closeActiveWysiwygPopover()
  flushEditorContent()
}
window.__vmdAfterEditorModeChange = (mode) => {
  refreshModeDependentFeatures()
  const content = vditor.getValue()
  postEditorContent()
  if (
    content === lastPostedEditorContent &&
    sentEditorContent.size === 0
  ) {
    postEditorBaseline(content, acknowledgedDocumentVersion)
  }
  vscode.postMessage({
    command: 'save-options',
    options: { mode },
  })
}

function scheduleEditorContent(): void {
  editorSyncPending = true
  if (editorSyncTimer !== null) return

  editorSyncTimer = setTimeout(() => {
    editorSyncTimer = null
    flushEditorContent()
    flushDeferredHostSnapshot()
  }, EDIT_SYNC_DELAY_MS)
}

;(window as any).__vmdCommitProgrammaticEdit = () => {
  scheduleEditorContent()
}

function isEditorEventTarget(target: EventTarget | null): boolean {
  const editor = getVditorEditorElement()
  return !!editor && target instanceof Node && editor.contains(target)
}

document.addEventListener(
  'compositionstart',
  (event) => {
    if (!isEditorEventTarget(event.target)) return
    vmdIsComposing = true
  },
  true
)

window.addEventListener('focus', () => {
  vmdWebviewHasFocus = true
})

window.addEventListener('blur', () => {
  flushEditorContent()
  vmdWebviewHasFocus = false
  queueMicrotask(flushDeferredHostSnapshot)
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return
  flushEditorContent()
  vmdWebviewHasFocus = false
  flushDeferredHostSnapshot()
})

window.addEventListener('pagehide', () => {
  flushEditorContent()
})

document.addEventListener(
  'compositionend',
  (event) => {
    if (!vmdIsComposing || !isEditorEventTarget(event.target)) return
    vmdIsComposing = false
    queueMicrotask(() => {
      flushEditorContent()
      flushDeferredHostSnapshot()
    })
  },
  true
)

function initVditor(msg) {
  const initializationGeneration = editorGeneration
  const content = msg.content
  // Hide the editor for the duration of its initial or explicitly requested rebuild.
  // Ordinary document and theme updates never come through this function.
  document.body.removeAttribute('data-vmd-ready')
  // Keeps Vditor off unpkg.com for its parser. Staying in the merge base lets the
  // host, and the interaction harness, point it somewhere else.
  const requestedMode = msg.options?.mode === 'sv' ? 'sv' : 'wysiwyg'
  const receivedOptions =
    msg.options && typeof msg.options === 'object' ? msg.options : {}
  const receivedToolbarShortcuts = receivedOptions.toolbarShortcuts
  const vditorOptions = { ...receivedOptions }
  delete vditorOptions.toolbarShortcuts
  toolbarShortcutController.setShortcuts(receivedToolbarShortcuts)
  const receivedHint =
    receivedOptions.hint && typeof receivedOptions.hint === 'object'
      ? receivedOptions.hint
      : {}
  const receivedPreview =
    receivedOptions.preview && typeof receivedOptions.preview === 'object'
      ? receivedOptions.preview
      : {}
  const receivedMath =
    receivedPreview.math && typeof receivedPreview.math === 'object'
      ? receivedPreview.math
      : {}
  const defaultOptions: any = {
    _lutePath: localVditorAsset('lute.min.js'),
    ...vditorOptions,
    // Lute appends /<name>.png, so this stays a directory URL with no trailing
    // slash, matching the CDN default it replaces.
    hint: {
      emojiPath: localVditorAsset('emoji'),
      ...receivedHint,
    },
    preview: {
      ...receivedPreview,
      math: {
        ...receivedMath,
        inlineDigit: true,
        // Vditor loads MathJax with a synchronous XHR and assumes startup
        // succeeded. A blocked or failed CDN request then aborts initialization
        // before `after()` can reveal the editor. KaTeX loads asynchronously, so
        // documents containing formulas can still open when the CDN is unavailable.
        engine: 'KaTeX',
      },
    },
  }
  // Enforce the complete supported-mode set again at the renderer boundary.
  // Persisted, malformed, or older host options cannot reactivate another mode.
  defaultOptions.mode = requestedMode
  // Supplying `i18n` makes Vditor use the object instead of fetching a locale
  // script from the CDN. Resolved after the merge because a host-supplied `lang`
  // overrides this webview's own, and the two must not disagree.
  if (!defaultOptions.i18n) {
    const effectiveLang = defaultOptions.lang || lang
    defaultOptions.i18n = vditorI18n[effectiveLang] || vditorI18n.en_US
  }
  // The edit-mode switch owns split preview; the More menu has no preview
  // controls. Always make SV mode a two-pane editor/preview layout and remove
  // Vditor's built-in device and platform action bar.
  defaultOptions.preview = defaultOptions.preview || {}
  defaultOptions.preview.mode = 'both'
  defaultOptions.preview.actions = []
  // There are exactly two built-in themes. The extension host maps the active
  // VS Code color theme to one of them, while the CSS files use VS Code color
  // tokens so different themes of the same kind are reflected as well.
  const builtInTheme = BUILT_IN_THEMES[setBuiltInTheme(msg.theme)]
  defaultOptions.theme = builtInTheme.editor
  // The matching content-theme rules are bundled in themes/*.css. An empty
  // path prevents Vditor from replacing them with a CDN stylesheet.
  defaultOptions.preview.theme = {
    current: builtInTheme.preview,
    path: '',
  }
  defaultOptions.preview.hljs = {
    ...(defaultOptions.preview.hljs || {}),
    style: builtInTheme.code,
  }
  defaultOptions.preview.markdown = {
    ...(defaultOptions.preview.markdown || {}),
    // Raw HTML is rendered inside a VS Code webview; never let a persisted
    // Vditor option disable Lute's sanitizer.
    sanitize: true,
  }
  // Vditor 3.11.2 invokes this optional callback without a guard. Use it to
  // remove generic block actions and adjust the remaining context controls.
  const customWysiwygToolbar =
    typeof defaultOptions.customWysiwygToolbar === 'function'
      ? defaultOptions.customWysiwygToolbar
      : null
  defaultOptions.customWysiwygToolbar = (type: string, popover: HTMLElement) => {
    customWysiwygToolbar?.(type, popover)
    customizeWysiwygPopover(type, popover)
  }
  const configuredKeydown =
    typeof defaultOptions.keydown === 'function' ? defaultOptions.keydown : null
  defaultOptions.keydown = (event: KeyboardEvent) => {
    configuredKeydown?.(event)

    const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
    const isPrimaryModifier = isMac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey
    if (
      isPrimaryModifier &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'b'
    ) {
      // Vditor handles the formatting command later in its own listener.
      // Stopping propagation here prevents VS Code from also toggling its sidebar.
      event.stopPropagation()
    }

    handleRenderedListTab(window.vditor, event)
  }
  if (window.vditor) {
    closeActiveWysiwygPopover()
    vditor.destroy()
    window.vditor = null
  }
  window.vditor = new Vditor('app', {
    width: '100%',
    height: '100%',
    minHeight: '100%',
    lang,
    value: content,
    mode: 'wysiwyg',
    cache: { enable: false },
    toolbar,
    toolbarConfig: { pin: true },
    ...defaultOptions,
    // The Ant icon sprite is bundled above. A falsy value prevents Vditor from
    // injecting a second, CDN-hosted icon script after initialization.
    icon: '' as any,
    after() {
      // Lute deletes the blank line between front matter and the body on every
      // WYSIWYG round trip. Attach the repair to this fresh instance so wrappers
      // cannot stack across re-inits, and seed it from the host's text rather
      // than the editor's, which has already passed through the parser once.
      attachFrontMatterSeparator(vditor, content)
      installSvCodeIndentRepair(getVditorInternals(vditor)?.lute)
      // A document that opened straight into Split View was rendered once before
      // this callback, by the renderer the line above has only now repaired. Build
      // it again from the host's text, but only if that first pass really did lose
      // something, so the common case stays a single render.
      if (
        getVditorMode() === 'sv' &&
        !isSameDocumentText(vditor.getValue(), content)
      ) {
        vditor.setValue(content)
      }
      lastPostedEditorContent = vditor.getValue()
      postEditorBaseline(
        lastPostedEditorContent,
        acknowledgedDocumentVersion,
        initializationGeneration
      )
      installToolbarSelectionPreserver(vditor)
      syncEditorModeToolbar(vditor)
      toolbarShortcutController.rebind()
      installWysiwygListCommands(vditor)
      if (!(window as any).__vmdDetails) {
        ;(window as any).__vmdDetails = initWysiwygDetails()
      } else {
        ;(window as any).__vmdDetails.rebind?.()
      }
      if (!(window as any).__vmdAlerts) {
        ;(window as any).__vmdAlerts = initWysiwygAlerts()
      } else {
        ;(window as any).__vmdAlerts.rebind?.()
      }
      if (!(window as any).__vmdCodeBlocks) {
        ;(window as any).__vmdCodeBlocks = initWysiwygCodeBlocks()
      } else {
        ;(window as any).__vmdCodeBlocks.rebind?.()
      }
      if (!window.__vmdSourceEditors) {
        window.__vmdSourceEditors = initWysiwygSourceEditors()
      } else {
        window.__vmdSourceEditors.rebind?.()
      }
      if (!window.__vmdHtmlPresentation) {
        window.__vmdHtmlPresentation = initWysiwygHtmlPresentation()
      } else {
        window.__vmdHtmlPresentation.rebind?.()
      }
      if (!window.__vmdHeadingLevels) {
        window.__vmdHeadingLevels = initWysiwygHeadingLevels()
      } else {
        window.__vmdHeadingLevels.rebind()
      }
      // Unknown values were already rejected by the host, so this only has to
      // cover the case of an older host that sends no value at all.
      const frontMatterDisplay: FrontMatterDisplay =
        msg.options?.frontMatterDisplay ?? 'table'
      if (!(window as any).__vmdFrontMatter) {
        ;(window as any).__vmdFrontMatter =
          initWysiwygFrontMatter(frontMatterDisplay)
      } else {
        ;(window as any).__vmdFrontMatter.setDisplay?.(frontMatterDisplay)
        ;(window as any).__vmdFrontMatter.rebind?.()
      }
      initTableContextMenu()
      initBlockContextMenu()
      vditor.focus()
      // Rebind split scrolling to the newly created editor root after rebuilds.
      if (!(window as any).__vmdSplitScrollSync) {
        ;(window as any).__vmdSplitScrollSync = initSplitScrollSync(vditor)
      } else {
        ;(window as any).__vmdSplitScrollSync.rebind?.(vditor)
      }
      restoreScrollPosition(msg.scrollTop)
      // Reveal the editor (see main.css) only once Vditor's own DOM/CSS has fully
      // settled and the saved scroll position has already been applied, so the very
      // first thing the user ever sees is the final state - never an intermediate,
      // oddly-scaled toolbar or a visible jump from the top to the restored position.
      requestAnimationFrame(() => {
        document.body.setAttribute('data-vmd-ready', '1')
      })
    },
    input() {
      // getValue() serializes the complete document in both supported modes. Coalesce
      // typing bursts while flushing synchronously for composition, save, blur,
      // and page hiding so the final edit is never lost.
      if (!vmdIsComposing) scheduleEditorContent()
    },
    upload: {
      url: '/fuzzy', // 没有 url 参数粘贴图片无法上传 see: https://github.com/Vanessa219/vditor/blob/d7628a0a7cfe5d28b055469bf06fb0ba5cfaa1b2/src/ts/util/fixBrowserBehavior.ts#L1409
      async handler(files) {
        const fileInfos = await Promise.all(
          files.map(async (f, index) => {
            const safeName = (f.name || 'file')
              .normalize('NFKC')
              .replace(/[^\p{L}\p{N}._-]+/gu, '_')
              .replace(/^\.+/, '') || 'file'
            const randomPart = Array.from(
              crypto.getRandomValues(new Uint32Array(2))
            )
              .map((value) => value.toString(36))
              .join('')
            return {
              base64: await fileToBase64(f),
              mime: f.type,
              name: `${formatUploadTimestamp(new Date())}_${index}_${randomPart}_${safeName}`,
              size: f.size,
            }
          })
        )
        vscode.postMessage({
          command: 'upload',
          files: fileInfos,
        })
      },
    },
  })
}

function handleEditAcknowledgement(msg: any): void {
  const seq = Number(msg.seq)
  const documentVersion = Number(msg.documentVersion)
  const generation = Number(msg.generation)
  if (
    !Number.isInteger(seq) ||
    !Number.isInteger(documentVersion) ||
    !Number.isInteger(generation) ||
    generation !== editorGeneration
  ) {
    return
  }

  const sentContent = sentEditorContent.get(seq)
  for (const candidate of Array.from(sentEditorContent.keys())) {
    if (candidate <= seq) sentEditorContent.delete(candidate)
  }

  const snapshot: HostDocumentSnapshot = {
    content: String(msg.content),
    documentVersion,
  }

  // A normal acknowledgement confirms an ancestor of any newer local edits,
  // so their next message can safely use this newer document version as base.
  if (sentContent !== undefined && snapshot.content === sentContent) {
    acknowledgedDocumentVersion = snapshot.documentVersion
    if (vditor.getValue() === snapshot.content) {
      lastPostedEditorContent = snapshot.content
    }
    // A newer edit may already be visible, so report the exact acknowledged
    // editor ancestor rather than the current getValue().
    postEditorBaseline(sentContent, snapshot.documentVersion, generation)
  } else {
    // The host merged external content into this acknowledgement. Treat it like
    // every other host update: queue it while the webview owns the edit session.
    acceptHostSnapshot(snapshot)
  }

  flushDeferredHostSnapshot()
}

function initializeFromMessage(msg) {
  const fixedMode = msg.options?.mode === 'sv' ? 'sv' : 'wysiwyg'
  const incomingGeneration = Number(msg.editorGeneration)
  editorGeneration = Number.isInteger(incomingGeneration)
    ? incomingGeneration
    : editorGeneration + 1
  projectionSerial = 0
  acknowledgedDocumentVersion = Number.isInteger(msg.documentVersion)
    ? msg.documentVersion
    : 0
  sentEditorContent.clear()
  clearScheduledEditorSync()
  editorSyncPending = false
  deferredHostSnapshot = null
  // Select the built-in theme before applying project CSS or creating Vditor so
  // the first rendered frame already uses the final appearance.
  document.body.removeAttribute('data-vmd-ready')
  setBuiltInTheme(msg.theme)
  if (Object.prototype.hasOwnProperty.call(msg, 'workspaceStyleCss')) {
    applyWorkspaceStyle(msg.workspaceStyleCss)
      console.info(
        '[markdown-interactor] workspace CSS:',
        msg.workspaceStylePath || 'not found'
      )
    }
  if (msg.options && msg.options.useVscodeThemeColor) {
    document.body.setAttribute('data-use-vscode-theme-color', '1')
  } else {
    document.body.setAttribute('data-use-vscode-theme-color', '0')
  }
  try {
    initVditor(msg)
  } catch (error) {
    // reset options when error
    console.error(error)
    initVditor({
      content: msg.content,
      theme: msg.theme,
      options: { mode: fixedMode },
    })
  }
}

window.addEventListener('message', (e) => {
  const msg = e.data
  switch (msg.command) {
    case 'update': {
      if (msg.type === 'init') {
        initializeFromMessage(msg)
      } else {
        const incomingGeneration = Number(msg.editorGeneration)
        if (
          !Number.isInteger(incomingGeneration) ||
          incomingGeneration !== editorGeneration
        ) {
          break
        }
        acceptHostSnapshot({
          content: msg.content,
          documentVersion: msg.documentVersion,
        })
      }
      break
    }
    case 'edit-ack': {
      handleEditAcknowledgement(msg)
      break
    }
    case 'theme': {
      updateBuiltInTheme(msg.theme)
      break
    }
    case 'toolbar-shortcuts': {
      toolbarShortcutController.setShortcuts(msg.shortcuts)
      toolbarShortcutController.rebind()
      break
    }
    case 'workspace-style': {
      applyWorkspaceStyle(msg.css)
      vscode.postMessage({
        command: 'info',
        content:
          msg.css === null
            ? 'No .vscode/markdown-interactor.css file was found for this document.'
            : `Workspace CSS reloaded successfully: ${msg.path}`,
      })
      break
    }
    case 'focus': {
      vditor.focus()
      break
    }
    case 'uploaded': {
      msg.files.forEach((f) => {
        const markdownPath = encodeURI(f)
          .replace(/\(/g, '%28')
          .replace(/\)/g, '%29')
        const lowerPath = f.toLowerCase()
        if (
          lowerPath.endsWith('.wav') ||
          lowerPath.endsWith('.mp3') ||
          lowerPath.endsWith('.ogg')
        ) {
          vditor.insertValue(
            `\n\n<audio controls="controls" src="${markdownPath}"></audio>\n\n`
          )
        } else {
          const i = new Image()
          i.src = f
          i.onload = () => {
            vditor.insertValue(`\n\n![](${markdownPath})\n\n`)
          }
          i.onerror = () => {
            vditor.insertValue(
              `\n\n[${f.split('/').slice(-1)[0]}](${markdownPath})\n\n`
            )
          }
        }
      })
      break
    }
    default:
      break
  }
})

fixLinkClick()

vscode.postMessage({ command: 'ready' })
