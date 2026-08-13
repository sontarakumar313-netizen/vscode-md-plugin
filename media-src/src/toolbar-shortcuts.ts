const TOOLBAR_ACTION_IDS = [
  'outline',
  'save',
  'headings',
  'heading-1',
  'heading-2',
  'heading-3',
  'heading-4',
  'heading-5',
  'heading-6',
  'bold',
  'italic',
  'strike',
  'link',
  'list',
  'ordered-list',
  'check',
  'outdent',
  'indent',
  'quote',
  'vmd-alert',
  'line',
  'code',
  'inline-code',
  'math-block',
  'math-inline',
  'details',
  'insert-before',
  'insert-after',
  'upload',
  'table',
  'vmd-edit-mode',
  'vmd-mode-wysiwyg',
  'vmd-mode-sv',
  'more',
  'copy-markdown',
  'copy-html',
  'reload-workspace-style',
  'normalize-formatting',
  'reset-config',
  'devtools',
  'info',
  'help',
] as const

type ToolbarActionId = (typeof TOOLBAR_ACTION_IDS)[number]

interface ParsedShortcut {
  alt: boolean
  canonical: string
  ctrl: boolean
  display: string
  key: string
  meta: boolean
  shift: boolean
}

export interface ToolbarShortcutController {
  dispose(): void
  rebind(): void
  setShortcuts(value: unknown): void
}

const TOOLBAR_ACTION_ID_SET = new Set<string>(TOOLBAR_ACTION_IDS)
const HEADING_ACTION_PATTERN = /^heading-([1-6])$/
const INPUT_SAFE_ACTIONS = new Set<ToolbarActionId>(['save'])
const KEY_ALIASES: Readonly<Record<string, string>> = {
  down: 'arrowdown',
  esc: 'escape',
  left: 'arrowleft',
  option: 'alt',
  return: 'enter',
  right: 'arrowright',
  spacebar: 'space',
  up: 'arrowup',
}
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
const NAMED_KEYS = new Set([
  'arrowdown',
  'arrowleft',
  'arrowright',
  'arrowup',
  'backspace',
  'delete',
  'end',
  'enter',
  'escape',
  'home',
  'pagedown',
  'pageup',
  'space',
  'tab',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform)
}

function normalizeKey(value: string): string | null {
  const lower = value.toLowerCase()
  const alias = KEY_ALIASES[lower] || lower
  if (
    alias.length === 1 &&
    "abcdefghijklmnopqrstuvwxyz0123456789,./;'[]\\-=`".includes(alias)
  ) {
    return alias
  }
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(alias)) return alias
  return NAMED_KEYS.has(alias) ? alias : null
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
  if (!value || value.length > 80 || /\s/.test(value)) return null

  let ctrl = false
  let meta = false
  let alt = false
  let shift = false
  let key: string | null = null
  const seen = new Set<string>()

  for (const rawPart of value.split('+')) {
    if (!rawPart) return null
    const lower = rawPart.toLowerCase()
    const part = KEY_ALIASES[lower] || lower
    if (seen.has(part)) return null
    seen.add(part)

    if (part === 'mod') {
      if (isMacPlatform()) meta = true
      else ctrl = true
    } else if (part === 'ctrl' || part === 'control') {
      ctrl = true
    } else if (part === 'cmd' || part === 'command' || part === 'meta') {
      meta = true
    } else if (part === 'alt') {
      alt = true
    } else if (part === 'shift') {
      shift = true
    } else {
      if (key !== null) return null
      key = normalizeKey(part)
      if (!key) return null
    }
  }

  if (!key) return null
  if (!ctrl && !meta && !alt && !shift && !/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(key)) {
    return null
  }

  const displayParts: string[] = []
  if (ctrl) displayParts.push('Ctrl')
  if (meta) displayParts.push(isMacPlatform() ? 'Cmd' : 'Meta')
  if (alt) displayParts.push(isMacPlatform() ? 'Option' : 'Alt')
  if (shift) displayParts.push('Shift')
  displayParts.push(keyLabel(key))

  return {
    alt,
    canonical: `${ctrl ? '1' : '0'}${meta ? '1' : '0'}${
      alt ? '1' : '0'
    }${shift ? '1' : '0'}:${key}`,
    ctrl,
    display: displayParts.join('+'),
    key,
    meta,
    shift,
  }
}

function isReservedShortcut(shortcut: ParsedShortcut): boolean {
  const primary = isMacPlatform()
    ? shortcut.meta && !shortcut.ctrl
    : shortcut.ctrl && !shortcut.meta
  return (
    primary &&
    !shortcut.alt &&
    ((!shortcut.shift &&
      ['a', 'c', 'f', 'm', 'v', 'x', 'y', 'z'].includes(shortcut.key)) ||
      (shortcut.shift && shortcut.key === 'z'))
  )
}

function eventKey(event: KeyboardEvent): string | null {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5)
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(event.code)) {
    return event.code.toLowerCase()
  }
  const codeKey = CODE_KEYS[event.code]
  return codeKey || normalizeKey(event.key)
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
        if (!shortcut || isReservedShortcut(shortcut)) continue
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
