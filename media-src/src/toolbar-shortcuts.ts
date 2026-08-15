import {
  TOOLBAR_ACTION_IDS,
  isReservedToolbarShortcut,
  normalizeToolbarShortcutKey,
  parseToolbarShortcut,
} from '../../src/toolbar-shortcut-core'
import type {
  ParsedToolbarShortcut,
  ToolbarActionId,
} from '../../src/toolbar-shortcut-core'

type ParsedShortcut = ParsedToolbarShortcut & { display: string }

export interface ToolbarShortcutController {
  dispose(): void
  rebind(): void
  setShortcuts(value: unknown): void
}

const TOOLBAR_ACTION_ID_SET = new Set<string>(TOOLBAR_ACTION_IDS)
const HEADING_ACTION_PATTERN = /^heading-([1-6])$/
const INPUT_SAFE_ACTIONS = new Set<ToolbarActionId>(['save'])
const CODE_KEYS: Readonly<Record<string, string>> = {
  Backquote: '`',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Equal: '=',
  Minus: '-',
  Period: '.',
  Quote: "'",
  Semicolon: ';',
  Slash: '/',
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform)
}

function keyLabel(key: string): string {
  const labels: Readonly<Record<string, string>> = {
    arrowdown: 'Down',
    arrowleft: 'Left',
    arrowright: 'Right',
    arrowup: 'Up',
    backspace: 'Backspace',
    delete: 'Delete',
    end: 'End',
    enter: 'Enter',
    escape: 'Escape',
    home: 'Home',
    pagedown: 'PageDown',
    pageup: 'PageUp',
    space: 'Space',
    tab: 'Tab',
  }
  return labels[key] || key.toUpperCase()
}

function parseShortcut(value: string): ParsedShortcut | null {
  const parsed = parseToolbarShortcut(value, isMacPlatform())
  if (!parsed) return null

  const displayParts: string[] = []
  if (parsed.ctrl) displayParts.push('Ctrl')
  if (parsed.meta) displayParts.push(isMacPlatform() ? 'Cmd' : 'Meta')
  if (parsed.alt) displayParts.push(isMacPlatform() ? 'Option' : 'Alt')
  if (parsed.shift) displayParts.push('Shift')
  displayParts.push(keyLabel(parsed.key))
  return { ...parsed, display: displayParts.join('+') }
}

function eventKey(event: KeyboardEvent): string | null {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5)
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(event.code)) {
    return event.code.toLowerCase()
  }
  const codeKey = CODE_KEYS[event.code]
  return codeKey || normalizeToolbarShortcutKey(event.key)
}

function matchesEvent(
  shortcut: ParsedShortcut,
  event: KeyboardEvent
): boolean {
  return (
    shortcut.ctrl === event.ctrlKey &&
    shortcut.meta === event.metaKey &&
    shortcut.alt === event.altKey &&
    shortcut.shift === event.shiftKey &&
    shortcut.key === eventKey(event)
  )
}

function actionElement(id: ToolbarActionId): HTMLElement | null {
  const toolbar = document.querySelector<HTMLElement>('.vditor-toolbar')
  if (!toolbar) return null

  const heading = HEADING_ACTION_PATTERN.exec(id)
  if (heading) {
    return toolbar.querySelector<HTMLElement>(
      `[data-type="headings"] + .vditor-hint [data-tag="h${heading[1]}"]`
    ) || toolbar
      .querySelector<HTMLElement>('[data-type="headings"]')
      ?.parentElement?.querySelector<HTMLElement>(
        `.vditor-hint [data-tag="h${heading[1]}"]`
      ) || null
  }

  if (id === 'upload') {
    return toolbar.querySelector<HTMLInputElement>(
      '[data-type="upload"] input[type="file"]'
    )
  }
  return toolbar.querySelector<HTMLElement>(`[data-type="${id}"]`)
}

function actionIsDisabled(element: HTMLElement): boolean {
  if (element.classList.contains('vditor-menu--disabled')) return true
  const item = element.closest<HTMLElement>('.vditor-toolbar__item')
  return !!item?.querySelector(':scope > .vditor-menu--disabled')
}

function isPopoverInput(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.matches('input, textarea, select')) return true
  const editable = target.closest<HTMLElement>('[contenteditable="true"]')
  return !!editable && !editable.classList.contains('vditor-reset')
}

function ariaShortcut(shortcut: ParsedShortcut): string {
  const parts: string[] = []
  if (shortcut.ctrl) parts.push('Control')
  if (shortcut.meta) parts.push('Meta')
  if (shortcut.alt) parts.push('Alt')
  if (shortcut.shift) parts.push('Shift')
  parts.push(keyLabel(shortcut.key))
  return parts.join('+')
}

/**
 * Owns configurable toolbar hotkeys before Vditor or the VS Code workbench can
 * observe them. Vditor rebuilds its toolbar during editor reinitialization, so
 * DOM label binding is deliberately separate from the single document listener.
 */
export function installToolbarShortcutController(): ToolbarShortcutController {
  let shortcuts = new Map<ToolbarActionId, ParsedShortcut>()
  let shortcutActions = new Map<string, ToolbarActionId>()
  let toolbar: HTMLElement | null = null
  let toolbarObserver: MutationObserver | null = null

  const updateLabels = (): void => {
    for (const id of TOOLBAR_ACTION_IDS) {
      const element = actionElement(id)
      if (!element) continue
      const shortcut = shortcuts.get(id)
      if (shortcut) {
        element.setAttribute('aria-keyshortcuts', ariaShortcut(shortcut))
      } else {
        element.removeAttribute('aria-keyshortcuts')
      }

      if (
        element.parentElement?.classList.contains('vditor-toolbar__item') &&
        element.classList.contains('vditor-tooltipped')
      ) {
        const current = element.getAttribute('aria-label') || ''
        const base = element.dataset.vmdShortcutBaseLabel || current
        if (!element.dataset.vmdShortcutBaseLabel) {
          element.dataset.vmdShortcutBaseLabel = base
        }
        element.setAttribute(
          'aria-label',
          shortcut ? `${base} (${shortcut.display})` : base
        )
      }
    }
  }

  const syncOpenMenuTooltips = (): void => {
    toolbar
      ?.querySelectorAll<HTMLElement>('.vditor-toolbar__item')
      .forEach((item) => {
        const button = item.querySelector<HTMLElement>(
          ':scope > .vditor-tooltipped'
        )
        const panel = item.querySelector<HTMLElement>(':scope > .vditor-hint')
        button?.classList.toggle(
          'vmd-toolbar-menu-open',
          !!panel && panel.style.display === 'block'
        )
      })
  }

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.keyCode === 229) return
    let matched: ToolbarActionId | null = null
    for (const [canonical, id] of shortcutActions) {
      const shortcut = shortcuts.get(id)
      if (shortcut?.canonical === canonical && matchesEvent(shortcut, event)) {
        matched = id
        break
      }
    }
    if (!matched) return

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    if (event.repeat) return
    if (isPopoverInput(event.target) && !INPUT_SAFE_ACTIONS.has(matched)) return

    const element = actionElement(matched)
    if (!element || actionIsDisabled(element)) return
    element.click()
    requestAnimationFrame(syncOpenMenuTooltips)
  }

  const onToolbarClick = (): void => {
    requestAnimationFrame(syncOpenMenuTooltips)
  }

  const rebind = (): void => {
    const nextToolbar = document.querySelector<HTMLElement>('.vditor-toolbar')
    if (nextToolbar === toolbar) {
      updateLabels()
      syncOpenMenuTooltips()
      return
    }
    toolbarObserver?.disconnect()
    toolbar?.removeEventListener('click', onToolbarClick, true)
    toolbar = nextToolbar
    if (!toolbar) return
    toolbar.addEventListener('click', onToolbarClick, true)
    toolbarObserver = new MutationObserver(syncOpenMenuTooltips)
    toolbarObserver.observe(toolbar, {
      attributes: true,
      attributeFilter: ['style'],
      subtree: true,
    })
    updateLabels()
    syncOpenMenuTooltips()
  }

  const setShortcuts = (value: unknown): void => {
    const next = new Map<ToolbarActionId, ParsedShortcut>()
    const assignments = new Map<string, ToolbarActionId[]>()
    if (isRecord(value)) {
      for (const [id, configured] of Object.entries(value)) {
        if (
          !TOOLBAR_ACTION_ID_SET.has(id) ||
          typeof configured !== 'string' ||
          !configured
        ) {
          continue
        }
        const shortcut = parseShortcut(configured)
        if (
          !shortcut ||
          isReservedToolbarShortcut(shortcut, isMacPlatform())
        ) {
          continue
        }
        const action = id as ToolbarActionId
        next.set(action, shortcut)
        const ids = assignments.get(shortcut.canonical) || []
        ids.push(action)
        assignments.set(shortcut.canonical, ids)
      }
    }

    const nextActions = new Map<string, ToolbarActionId>()
    for (const [canonical, ids] of assignments) {
      if (ids.length !== 1) {
        ids.forEach((id) => next.delete(id))
        continue
      }
      nextActions.set(canonical, ids[0])
    }
    shortcuts = next
    shortcutActions = nextActions
    updateLabels()
  }

  document.addEventListener('keydown', onKeydown, true)

  return {
    dispose(): void {
      document.removeEventListener('keydown', onKeydown, true)
      toolbarObserver?.disconnect()
      toolbar?.removeEventListener('click', onToolbarClick, true)
      toolbar = null
      toolbarObserver = null
      shortcuts.clear()
      shortcutActions.clear()
    },
    rebind,
    setShortcuts,
  }
}
