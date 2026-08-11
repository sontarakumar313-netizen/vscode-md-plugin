import $ from 'jquery'
require('jquery-confirm')(window, $)
import 'jquery-confirm/css/jquery-confirm.css'

import _ from 'lodash'
import Vditor from 'vditor'
import { getVditorMode } from './vditor-adapter'
window.vscode =
  (window as any).acquireVsCodeApi && (window as any).acquireVsCodeApi()
;(window as any).global = window

declare global {
  export const vditor: Vditor
  export const vscode: any
  interface Window {
    vditor: Vditor
    vscode: any
    global: Window
  }
}

export function confirm(msg, onOk) {
  $.confirm({
    title: '',
    animation: 'top',
    closeAnimation: 'top',
    animateFromElement: false,
    boxWidth: '300px',
    useBootstrap: false,
    content: msg,
    buttons: {
      cancel: {
        text: 'Cancel',
      },
      confirm: {
        text: 'Confirm',
        action: onOk,
      },
    },
  })
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
// 只保存 Vditor 编辑模式。分屏预览由 SV 编辑模式固定启用，不再持久化
// preview 配置，避免旧版的预览选项重新生效。
export function saveVditorOptions() {
  const vditorOptions = {
    mode: getVditorMode(),
  }
  vscode.postMessage({
    command: 'save-options',
    options: vditorOptions,
  })
}
// toolbar 点击时保存配置
export function handleToolbarClick() {
  const buttons = $(
    '.vditor-toolbar .vditor-panel--left button, .vditor-toolbar .vditor-panel--arrow button'
  )
  buttons.off('click.vmd-options').on('click.vmd-options', () => {
    setTimeout(() => {
      ;(window as any).__vmdSearch?.rebind?.()
      ;(window as any).__vmdLineNumbers?.rebind?.()
    })
    setTimeout(() => {
      saveVditorOptions()
    }, 500)
  })
}

/**
 * Approximates the GitHub-style heading slug so in-page `#anchor` links (e.g. a Table
 * of Contents) can be matched against the rendered heading text.
 */
function slugifyHeading(text: string): string {
  return text
    .trim()
    // Vditor's IR mode keeps the literal `#`/`##`/... marker as part of the heading's
    // textContent, unlike the final rendered output, so strip it first.
    .replace(/^#{1,6}\s*/, '')
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
      : mode === 'wysiwyg'
        ? document.querySelector('.vditor-wysiwyg .vditor-reset')
        : document.querySelector('.vditor-ir .vditor-reset')
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

/**
 * Sends raw Markdown link targets to the extension host for opening.
 */
export function fixLinkClick() {
  const openLink = (url: string) => {
    vscode.postMessage({ command: 'open-link', href: url })
  }
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target as HTMLElement
      const link = target.closest('a')
      // Vditor's IR mode never renders a real `<a href>` for links: it always shows the
      // raw markdown syntax, with the url held in a `.vditor-ir__marker--link` marker
      // span inside a `[data-type="a"]` wrapper, instead of a real anchor element.
      const irLinkMarker = target
        .closest<HTMLElement>('[data-type="a"]')
        ?.querySelector('.vditor-ir__marker--link')
      const href =
        link?.getAttribute('href') || irLinkMarker?.textContent || undefined

      if (!href) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (href.startsWith('#')) {
        scrollToHeadingAnchor(href.slice(1))
        return
      }
      openLink(href)
    },
    // Intercept before Vditor's own click handler calls window.open(). Handling the
    // event in the bubbling phase lets both paths post the same open-link message.
    true
  )
  window.open = (url: string, ...args: any[]) => {
    openLink(url)
    return window
  }
}


/** error:
 We don't execute document.execCommand() this time, because it is called recursively.
(anonymous) @ main.js:32449
(anonymous) @ main.js:842
(anonymous) @ host.js:27
see: https://github.com/nwjs/nw.js/issues/3403 */
export function fixCut() {
  let _exec = document.execCommand.bind(document)
  document.execCommand = (cmd, ...args) => {
    if (cmd === 'delete') {
      setTimeout(() => {
        return _exec(cmd, ...args)
      })
    } else {
      return _exec(cmd, ...args)
    }
  }
}
