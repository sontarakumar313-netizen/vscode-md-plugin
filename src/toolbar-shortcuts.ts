import * as vscode from 'vscode'

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
  'info',
  'help',
] as const

export type ToolbarActionId = (typeof TOOLBAR_ACTION_IDS)[number]
export type ToolbarShortcutMap = Record<ToolbarActionId, string>

const TOOLBAR_ACTION_ID_SET = new Set<string>(TOOLBAR_ACTION_IDS)

export const DEFAULT_TOOLBAR_SHORTCUTS: ToolbarShortcutMap = {
  outline: '',
  save: 'Mod+S',
  headings: '',
  'heading-1': 'Mod+Alt+1',
  'heading-2': 'Mod+Alt+2',
  'heading-3': 'Mod+Alt+3',
  'heading-4': 'Mod+Alt+4',
  'heading-5': 'Mod+Alt+5',
  'heading-6': 'Mod+Alt+6',
  bold: 'Mod+B',
  italic: 'Mod+I',
  strike: 'Mod+Shift+X',
  link: 'Mod+K',
  list: 'Mod+Shift+8',
  'ordered-list': 'Mod+Shift+7',
  check: '',
  outdent: '',
  indent: '',
  quote: 'Mod+Shift+.',
  'vmd-alert': '',
  line: '',
  code: 'Mod+Alt+C',
  'inline-code': 'Mod+E',
  'math-block': '',
  'math-inline': '',
  details: '',
  'insert-before': '',
  'insert-after': '',
  upload: '',
  table: '',
  'vmd-edit-mode': '',
  'vmd-mode-wysiwyg': '',
  'vmd-mode-sv': '',
  more: '',
  'copy-markdown': '',
  'copy-html': '',
  'reload-workspace-style': '',
  'normalize-formatting': '',
  'reset-config': '',
  devtools: '',
  info: '',
  help: '',
}

interface ParsedShortcut {
  canonical: string
}

interface ToolbarShortcutConfiguration {
  shortcuts: ToolbarShortcutMap
  warnings: string[]
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeKey(value: string): string | undefined {
  const lower = value.toLowerCase()
  const alias = KEY_ALIASES[lower] || lower
  if (
    alias.length === 1 &&
    "abcdefghijklmnopqrstuvwxyz0123456789,./;'[]\\-=`".includes(alias)
  ) {
    return alias
  }
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(alias)) return alias
  return NAMED_KEYS.has(alias) ? alias : undefined
}

function parseShortcut(value: string): ParsedShortcut | undefined {
  if (value.length === 0 || value.length > 80 || /\s/.test(value)) {
    return undefined
  }

  let ctrl = false
  let meta = false
  let alt = false
  let shift = false
  let key: string | undefined
  const seen = new Set<string>()

  for (const rawPart of value.split('+')) {
    if (!rawPart) return undefined
    const lower = rawPart.toLowerCase()
    const part = KEY_ALIASES[lower] || lower
    if (seen.has(part)) return undefined
    seen.add(part)

    if (part === 'mod') {
      if (process.platform === 'darwin') meta = true
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
      if (key !== undefined) return undefined
      key = normalizeKey(part)
      if (!key) return undefined
    }
  }

  if (!key) return undefined
  if (!ctrl && !meta && !alt && !shift && !/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(key)) {
    return undefined
  }

  return {
    canonical: `${ctrl ? '1' : '0'}${meta ? '1' : '0'}${alt ? '1' : '0'}${
      shift ? '1' : '0'
    }:${key}`,
  }
}

function isReservedShortcut(parsed: ParsedShortcut): boolean {
  const [modifiers, key] = parsed.canonical.split(':')
  const ctrl = modifiers[0] === '1'
  const meta = modifiers[1] === '1'
  const alt = modifiers[2] === '1'
  const primary = process.platform === 'darwin' ? meta && !ctrl : ctrl && !meta
  return (
    primary &&
    !alt &&
    ((modifiers[3] !== '1' &&
      ['a', 'c', 'f', 'm', 'v', 'x', 'y', 'z'].includes(key)) ||
      (modifiers[3] === '1' && key === 'z'))
  )
}

function copyDefaults(): ToolbarShortcutMap {
  return { ...DEFAULT_TOOLBAR_SHORTCUTS }
}

export function readToolbarShortcutConfiguration(
  uri?: vscode.Uri
): ToolbarShortcutConfiguration {
  const shortcuts = copyDefaults()
  const warnings: string[] = []
  const raw = vscode.workspace
    .getConfiguration('markdown-interactor', uri)
    .get<unknown>('toolbarShortcuts')

  if (raw !== undefined && !isRecord(raw)) {
    warnings.push('toolbarShortcuts must be an object.')
  } else if (isRecord(raw)) {
    for (const [id, configured] of Object.entries(raw)) {
      if (!TOOLBAR_ACTION_ID_SET.has(id)) {
        warnings.push(`Unknown toolbar action: ${id.slice(0, 80)}.`)
        continue
      }
      if (typeof configured !== 'string') {
        warnings.push(`Shortcut for ${id} must be a string.`)
        continue
      }
      if (configured === '') {
        shortcuts[id as ToolbarActionId] = ''
        continue
      }
      const parsed = parseShortcut(configured)
      if (!parsed) {
        warnings.push(`Invalid shortcut for ${id}: ${configured.slice(0, 80)}.`)
        continue
      }
      if (isReservedShortcut(parsed)) {
        warnings.push(`Reserved editor shortcut cannot be assigned to ${id}: ${configured}.`)
        continue
      }
      shortcuts[id as ToolbarActionId] = configured
    }
  }

  const assignments = new Map<string, ToolbarActionId[]>()
  for (const id of TOOLBAR_ACTION_IDS) {
    const value = shortcuts[id]
    if (!value) continue
    const parsed = parseShortcut(value)
    if (!parsed) {
      shortcuts[id] = ''
      continue
    }
    const ids = assignments.get(parsed.canonical) || []
    ids.push(id)
    assignments.set(parsed.canonical, ids)
  }
  for (const ids of assignments.values()) {
    if (ids.length < 2) continue
    warnings.push(`Conflicting toolbar shortcut: ${ids.join(', ')}.`)
    for (const id of ids) shortcuts[id] = ''
  }

  return { shortcuts, warnings }
}
