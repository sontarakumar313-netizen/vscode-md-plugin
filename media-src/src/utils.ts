import Vditor from 'vditor'
import {
  getVditorInternals,
  getVditorMode,
  refreshVditorWysiwygToolbar,
  showVditorWysiwygLinkPopover,
} from './vditor-adapter'
import type { VditorMode } from './vditor-adapter'
import { setWysiwygPopoverTarget } from './wysiwyg-popover'
window.vscode =
  (window as any).acquireVsCodeApi && (window as any).acquireVsCodeApi()
declare global {
  export const vditor: Vditor
  export const vscode: any
  interface Window {
    vditor: Vditor
    vscode: any
    __vmdBeforeEditorModeChange?: () => void
    __vmdAfterEditorModeChange?: (mode: VditorMode) => void
    __vmdDetails?: { rebind?: () => void }
    __vmdAlerts?: { rebind?: () => void }
    __vmdCodeBlocks?: { rebind?: () => void }
    __vmdFrontMatter?: { rebind?: () => void }
    __vmdSplitScrollSync?: { rebind?: (editor?: unknown) => void }
  }
}

let activeConfirmDialog: HTMLDialogElement | null = null

export function confirm(msg: string, onOk: () => void): void {
  if (activeConfirmDialog) {
    activeConfirmDialog.close()
    activeConfirmDialog.remove()
    activeConfirmDialog = null
  }

  const previousFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  const dialog = document.createElement('dialog')
  dialog.className = 'vmd-confirm-dialog'
  dialog.setAttribute('aria-label', 'Confirmation')

  const content = document.createElement('p')
  content.textContent = msg
  dialog.appendChild(content)

  const actions = document.createElement('div')
  actions.className = 'vmd-confirm-dialog__actions'
  const cancelButton = document.createElement('button')
  cancelButton.type = 'button'
  cancelButton.textContent = 'Cancel'
  cancelButton.dataset.action = 'cancel'
  const confirmButton = document.createElement('button')
  confirmButton.type = 'button'
  confirmButton.textContent = 'Confirm'
  confirmButton.dataset.action = 'confirm'
  actions.append(cancelButton, confirmButton)
  dialog.appendChild(actions)

  const finish = (confirmed: boolean) => {
    if (!dialog.isConnected) return
    if (dialog.open) dialog.close()
    if (activeConfirmDialog === dialog) activeConfirmDialog = null
    dialog.remove()
    if (previousFocus?.isConnected) previousFocus.focus()
    if (confirmed) onOk()
  }
  cancelButton.addEventListener('click', () => finish(false))
  confirmButton.addEventListener('click', () => finish(true))
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    finish(false)
  })

  document.body.appendChild(dialog)
  activeConfirmDialog = dialog
  dialog.showModal()
  cancelButton.focus()
}
// 文件转base64用于传输
export const fileToBase64 = async (file) => {
  return new Promise((res, rej) => {
    const reader = new FileReader()
    reader.onload = function (evt) {
      res(evt.target.result.toString().split(',')[1])
    }
    reader.onerror = rej
    reader.readAsDataURL(file)
  })
}
/**
 * Approximates the GitHub-style heading slug so in-page `#anchor` links (e.g. a Table
 * of Contents) can be matched against the rendered heading text.
 */
function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\- ]+/gu, '')
    // GitHub's heading slugger replaces each space individually rather than collapsing
    // runs of whitespace, so e.g. "Foo & Bar" (which becomes "foo  bar" once the "&" is
    // stripped) turns into "foo--bar", not "foo-bar".
    .replace(/ /g, '-')
}

/**
 * Scrolls to the heading matching an in-page `#anchor` link. Returns true if a match
 * was found and scrolled to.
 */
function scrollToHeadingAnchor(fragment: string): boolean {
  let target: string
  try {
    target = decodeURIComponent(fragment).toLowerCase()
  } catch (_) {
    target = fragment.toLowerCase()
  }

  const mode = getVditorMode()
  const root =
    mode === 'sv'
      ? document.querySelector('.vditor-preview')
      : document.querySelector('.vditor-wysiwyg .vditor-reset')
  if (!root) return false

  const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6')
  for (const h of Array.from(headings)) {
    if (slugifyHeading(h.textContent || '') === target) {
      h.scrollIntoView({ block: 'start', behavior: 'smooth' })
      return true
    }
  }
  return false
}

function isExactPrimaryModifier(event: {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}): boolean {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
  return (
    !event.shiftKey &&
    !event.altKey &&
    (isMac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey)
  )
}

/**
 * Owns Markdown-link activation before Vditor's click handler can call
 * `window.open()`. A plain WYSIWYG click keeps the caret in the link and opens
 * its editable URL popover; Ctrl/Cmd+click is the only path that follows it.
 */
export function fixLinkClick() {
  const openLink = (url: string) => {
    vscode.postMessage({ command: 'open-link', href: url })
  }
  const setModifierCursor = (active: boolean) => {
    document.body.classList.toggle('vmd-link-primary-modifier', active)
  }
  document.addEventListener('keydown', (event) => {
    setModifierCursor(isExactPrimaryModifier(event))
  }, true)
  document.addEventListener('keyup', (event) => {
    setModifierCursor(isExactPrimaryModifier(event))
  }, true)
  window.addEventListener('blur', () => setModifierCursor(false))
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) setModifierCursor(false)
  })

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target
      const element = target instanceof Element ? target : null
      const link = element?.closest('a') || null
      const image = element?.closest('img') || null
      const isWysiwyg =
        getVditorMode() === 'wysiwyg' &&
        !!element?.closest('.vditor-wysiwyg .vditor-reset')

      // Capture every image target before Vditor builds and positions its shared
      // popover. Unlinked images return below because they have no anchor href.
      if (image && isWysiwyg) setWysiwygPopoverTarget(image)

      const href = link?.getAttribute('href') || undefined
      if (!href) return
      const followsLink = isExactPrimaryModifier(event)

      // A linked image owns its ordinary click: let Vditor's image branch open
      // the URL/title popover. The exact platform modifier still follows the
      // enclosing anchor.
      if (image && isWysiwyg && !followsLink) return

      // Vditor opens anchors from its bubbling listener. Claim every remaining
      // anchor click here so a plain or incorrectly-modified click cannot escape.
      event.preventDefault()
      event.stopImmediatePropagation()

      if (followsLink) {
        if (href.startsWith('#')) scrollToHeadingAnchor(href.slice(1))
        else openLink(href)
        return
      }

      if (isWysiwyg) {
        const internal = getVditorInternals()
        if (!showVditorWysiwygLinkPopover(internal, link)) {
          refreshVditorWysiwygToolbar(internal)
        }
      }
    },
    true
  )
  window.open = (url: string) => {
    openLink(url)
    return window
  }
}

