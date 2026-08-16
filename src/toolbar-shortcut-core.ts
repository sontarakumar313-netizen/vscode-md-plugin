export const TOOLBAR_ACTION_IDS = [
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
  'help',
] as const

export type ToolbarActionId = (typeof TOOLBAR_ACTION_IDS)[number]

export interface ParsedToolbarShortcut {
  alt: boolean
  canonical: string
  ctrl: boolean
  key: string
  meta: boolean
  shift: boolean
}

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

export function normalizeToolbarShortcutKey(value: string): string | null {
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

export function parseToolbarShortcut(
  value: string,
  isMac: boolean
): ParsedToolbarShortcut | null {
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
      if (isMac) meta = true
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
      key = normalizeToolbarShortcutKey(part)
      if (!key) return null
    }
  }

  if (!key) return null
  if (
    !ctrl &&
    !meta &&
    !alt &&
    !shift &&
    !/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(key)
  ) {
    return null
  }

  return {
    alt,
    canonical: `${ctrl ? '1' : '0'}${meta ? '1' : '0'}${
      alt ? '1' : '0'
    }${shift ? '1' : '0'}:${key}`,
    ctrl,
    key,
    meta,
    shift,
  }
}

export function isReservedToolbarShortcut(
  shortcut: ParsedToolbarShortcut,
  isMac: boolean
): boolean {
  const primary = isMac
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
