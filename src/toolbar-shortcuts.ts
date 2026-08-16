import * as vscode from 'vscode'
import {
  TOOLBAR_ACTION_IDS,
  isReservedToolbarShortcut,
  parseToolbarShortcut,
} from './toolbar-shortcut-core'
import type { ToolbarActionId } from './toolbar-shortcut-core'

export { TOOLBAR_ACTION_IDS } from './toolbar-shortcut-core'
export type { ToolbarActionId } from './toolbar-shortcut-core'
export type ToolbarShortcutMap = Record<ToolbarActionId, string>

const TOOLBAR_ACTION_ID_SET = new Set<string>(TOOLBAR_ACTION_IDS)
const IS_MAC = process.platform === 'darwin'

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
  help: '',
}

interface ToolbarShortcutConfiguration {
  shortcuts: ToolbarShortcutMap
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
      const parsed = parseToolbarShortcut(configured, IS_MAC)
      if (!parsed) {
        warnings.push(`Invalid shortcut for ${id}: ${configured.slice(0, 80)}.`)
        continue
      }
      if (isReservedToolbarShortcut(parsed, IS_MAC)) {
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
    const parsed = parseToolbarShortcut(value, IS_MAC)
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
