import './preload'

// Vditor normally fetches this SVG sprite from its CDN at runtime. Bundle it
// into the webview instead so toolbar and context-menu icons remain available
// when remote scripts are blocked by the webview CSP or the user is offline.
import 'vditor/dist/js/icons/ant.js'

import {
  fileToBase64,
  fixCut,
  fixLinkClick,
  handleToolbarClick,
  saveVditorOptions,
} from './utils'

import { merge } from 'lodash'
import Vditor from 'vditor'
import { format } from 'date-fns'
import 'vditor/dist/index.css'
import { captureCaretAnchor, restoreCaretAnchor } from './caret-anchor'
import { lang } from './lang'
import { toolbar } from './toolbar'
import { initTableContextMenu } from './table-context-menu'
import { customizeWysiwygPopover } from './wysiwyg-popover'
import {
  handleRenderedListTab,
  installWysiwygListCommands,
} from './wysiwyg-list'
import { initWysiwygDetails } from './wysiwyg-details'
import {
  attachFrontMatterSeparator,
  initWysiwygFrontMatter,
} from './wysiwyg-front-matter'
import type { FrontMatterDisplay } from './wysiwyg-front-matter'
import { initSearch } from './search'
import { initLineNumbers } from './line-numbers'
import { LatexMathCompatibility } from './math-delimiters'
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
import { installSvCodeIndentRepair } from './sv-code-indent'
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
function installCodeCopyHandler(): void {
  if ((window as any).__vmdCodeCopyHandlerInstalled) return
  ;(window as any).__vmdCodeCopyHandlerInstalled = true

  const setCopyLabel = (button: HTMLElement, copied: boolean) => {
    const i18n = (window as any).VditorI18n || {}
    button.setAttribute(
      'aria-label',
      copied ? i18n.copied || 'Copied' : i18n.copy || 'Copy'
    )
  }

  document.addEventListener(
    'click',
    (event) => {
      const target =
        event.target instanceof Element ? event.target : null
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
        setCopyLabel(button, true)
        return
      }

      // execCommand is the most compatible path for a click gesture, but some
      // webview hosts disable it. Use the asynchronous Clipboard API as a
      // fallback when the host exposes it.
      const writeText = navigator.clipboard?.writeText
      if (!writeText) {
        setCopyLabel(button, false)
        return
      }
      void writeText.call(navigator.clipboard, textarea.value).then(
        () => setCopyLabel(button, true),
        () => setCopyLabel(button, false)
      )
    },
    true
  )
}

installStructuredTabPolicy()
installCodeCopyHandler()

// Set to true only for local debugging of scroll-position persistence; verbose and
// not meant to ship enabled (this would spam the console for every scroll event).
const VMD_SCROLL_DEBUG = false
function scrollLog(...args: any[]) {
  if (!VMD_SCROLL_DEBUG) return
  console.log('[vmd-scroll]', ...args)
}

function getScrollEl(): HTMLElement | null {
  // The actual scrollable container isn't always the same node (depends on toolbar
  // pin state / layout), so pick whichever candidate is really overflowing instead of
  // hardcoding one selector.
  const mode = getVditorMode()
  const selectorsByMode: Record<string, string[]> = {
    ir: ['.vditor-ir .vditor-reset', '.vditor-ir'],
    wysiwyg: ['.vditor-wysiwyg .vditor-reset', '.vditor-wysiwyg'],
    sv: ['.vditor-sv.vditor-reset', '.vditor-sv'],
  }
  const candidates = [
    ...(selectorsByMode[mode] || []),
    '.vditor-content',
  ]
    .map((sel) => document.querySelector<HTMLElement>(sel))
    .filter(
      (element): element is HTMLElement =>
        !!element && element.getClientRects().length > 0
    )
  const overflowing = candidates.find((el) => el.scrollHeight - el.clientHeight > 10)
  return overflowing || candidates[0] || null
}

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
  if ((window as any).__vmdScrollTracked) return
  ;(window as any).__vmdScrollTracked = true

  document.addEventListener(
    'scroll',
    () => {
      const el = getScrollEl()
      if (!el) return
      if (vmdRestoreState.activeCancel) {
        if (el.scrollTop === vmdRestoreState.lastApplied) {
          // Our own restore just set this value; not a real user scroll.
          return
        }
        scrollLog('scroll during restore diverged to', el.scrollTop, '- treating as user input, cancelling restore')
        vmdRestoreState.activeCancel()
      }
      // Send synchronously on every scroll event, with no debounce/rAF buffering:
      // switching to a different file disposes this webview entirely (it is not
      // merely hidden), so any deferred reporting risks losing the very last
      // position if the switch happens before the timer/frame callback fires.
      scrollLog('reporting scroll', el.scrollTop, 'on', el.className)
      vscode.postMessage({ command: 'scroll', top: el.scrollTop })
    },
    true
  )
}

function restoreScrollPosition(scrollTop: number) {
  scrollLog('restoreScrollPosition called with', scrollTop)
  vmdRestoreState.activeCancel?.()
  if (!scrollTop) return
  const el = getScrollEl()
  if (!el) {
    scrollLog('no scroll element found, aborting restore')
    return
  }
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
    finish('cancelled - user input')
  }

  const finish = (reason: string) => {
    if (done) return
    done = true
    clearInterval(pollTimer)
    if (vmdRestoreState.activeCancel === cancel) {
      vmdRestoreState.activeCancel = null
      vmdRestoreState.lastApplied = null
    }
    scrollLog('restore finished:', reason, 'elapsed', Date.now() - startedAt, 'ms')
  }

  // Register with the coordinator BEFORE the first apply(), so trackScrollPosition
  // never observes a scroll position we just set without also seeing activeCancel.
  vmdRestoreState.activeCancel = cancel
  apply()

  const pollTimer = setInterval(() => {
    if (userScrolled) {
      finish('user scrolled')
      return
    }
    const now = Date.now()
    const h = el.scrollHeight
    if (h !== lastHeight) {
      lastHeight = h
      lastChangedAt = now
      apply()
      scrollLog('height changed to', h, 're-applied scrollTop', scrollTop, '-> actual', el.scrollTop)
    }
    if (now - lastChangedAt >= SETTLE_AFTER_MS) {
      finish('settled')
    } else if (now - startedAt >= HARD_CAP_MS) {
      finish('hard cap reached')
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
    ;(window as any).__vmdLineNumbers?.refresh?.()
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
  ;(window as any).__vmdLineNumbers?.refresh?.()
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
  const scrollTop = getScrollEl()?.scrollTop || 0
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
  console.log('msg', msg)
  const initializationGeneration = editorGeneration
  const latexMath = new LatexMathCompatibility()
  const content = latexMath.prepare(msg.content)
  // Hide the editor for the duration of its initial or explicitly requested rebuild.
  // Ordinary document and theme updates never come through this function.
  document.body.removeAttribute('data-vmd-ready')
  // Keeps Vditor off unpkg.com for its parser. Staying in the merge base lets the
  // host, and the interaction harness, point it somewhere else.
  let defaultOptions: any = {
    _lutePath: localVditorAsset('lute.min.js'),
    // Lute appends /<name>.png, so this stays a directory URL with no trailing
    // slash, matching the CDN default it replaces.
    hint: { emojiPath: localVditorAsset('emoji') },
  }
  defaultOptions = merge(defaultOptions, msg.options, {
    preview: {
      math: {
        inlineDigit: true,
      }
    }
  })
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
    vditor.destroy()
    window.vditor = null
  }
  window.vditor = new Vditor('app', {
    width: '100%',
    height: '100%',
    minHeight: '100%',
    lang,
    value: content,
    mode: 'ir',
    cache: { enable: false },
    toolbar,
    toolbarConfig: { pin: true },
    ...defaultOptions,
    // The Ant icon sprite is bundled above. A falsy value prevents Vditor from
    // injecting a second, CDN-hosted icon script after initialization.
    icon: '' as any,
    after() {
      // Vditor natively parses dollar math delimiters. Patch its public value
      // boundary so LaTeX-style \[ ... \] and \( ... \) render identically
      // without rewriting their delimiter style in the Markdown document.
      latexMath.attach(vditor)
      // Lute deletes the blank line between front matter and the body on every
      // WYSIWYG round trip. Wrapped after the math patch so it sees the finished
      // Markdown, and on the fresh instance this callback belongs to, so the
      // wrappers cannot stack across re-inits. Seeded from the host's text rather
      // than the editor's, which has already been through the parser once.
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
      handleToolbarClick()
      installWysiwygListCommands(vditor)
      if (!(window as any).__vmdDetails) {
        ;(window as any).__vmdDetails = initWysiwygDetails()
      } else {
        ;(window as any).__vmdDetails.rebind?.()
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
      vditor.focus()
      // Keep the search bar across Vditor re-inits, but rebind its observer to
      // the newly created editor root after every rebuild.
      if (!(window as any).__vmdSearch) {
        ;(window as any).__vmdSearch = initSearch()
      } else {
        ;(window as any).__vmdSearch.rebind?.()
      }
      if (!(window as any).__vmdLineNumbers) {
        ;(window as any).__vmdLineNumbers = initLineNumbers()
      } else {
        ;(window as any).__vmdLineNumbers.rebind?.()
      }
      if (!(window as any).__vmdSplitScrollSync) {
        ;(window as any).__vmdSplitScrollSync = initSplitScrollSync(vditor)
      } else {
        ;(window as any).__vmdSplitScrollSync.rebind?.(vditor)
      }
      trackScrollPosition()
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
      // getValue() serializes the complete document in IR/WYSIWYG mode. Coalesce
      // typing bursts while flushing synchronously for composition, save, blur,
      // and page hiding so the final edit is never lost.
      if (!vmdIsComposing) scheduleEditorContent()
    },
    upload: {
      url: '/fuzzy', // 没有 url 参数粘贴图片无法上传 see: https://github.com/Vanessa219/vditor/blob/d7628a0a7cfe5d28b055469bf06fb0ba5cfaa1b2/src/ts/util/fixBrowserBehavior.ts#L1409
      async handler(files) {
        // console.log('files', files)
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
              name: `${format(new Date(), 'yyyyMMdd_HHmmss_SSS')}_${index}_${randomPart}_${safeName}`,
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
    initVditor({ content: msg.content, theme: msg.theme })
    saveVditorOptions()
  }
  console.log('initVditor')
}

window.addEventListener('message', (e) => {
  const msg = e.data
  // console.log('msg from vscode', msg)
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
fixCut()

vscode.postMessage({ command: 'ready' })
