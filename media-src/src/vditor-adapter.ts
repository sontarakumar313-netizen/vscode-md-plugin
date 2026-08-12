import {
  deleteColumn,
  deleteRow,
  execAfterRender,
  insertColumn,
  insertRow,
  insertRowAbove,
  listIndent,
  listOutdent,
} from 'vditor/src/ts/util/fixBrowserBehavior'
import { setSelectionFocus } from 'vditor/src/ts/util/selection'
import { afterRenderEvent as commitWysiwygAfterRender } from 'vditor/src/ts/wysiwyg/afterRenderEvent'

export type VditorMode = 'wysiwyg' | 'sv'

/**
 * Vditor exposes most of the extension points used by this webview through an
 * internal object. Keep that dependency and the deep Vditor imports here so a
 * Vditor upgrade has one small, auditable compatibility surface.
 */
export function getVditorInternals(editor: any = window.vditor): any | null {
  const internal = editor?.vditor
  return internal && typeof internal === 'object' ? internal : null
}

export function getVditorMode(editor: any = window.vditor): VditorMode | null {
  const mode = getVditorInternals(editor)?.currentMode || editor?.getCurrentMode?.()
  return mode === 'wysiwyg' || mode === 'sv' ? mode : null
}

export function getVditorEditorElement(
  editor: any = window.vditor
): HTMLElement | null {
  const internal = getVditorInternals(editor)
  const mode = getVditorMode(editor)
  const element = mode ? internal?.[mode]?.element : null
  return element instanceof HTMLElement ? element : null
}

export interface VditorSplitElements {
  source: HTMLElement
  preview: HTMLElement
  previewContent: HTMLElement | null
}

export function getVditorSplitElements(
  editor: any = window.vditor
): VditorSplitElements | null {
  const internal = getVditorInternals(editor)
  const source = internal?.sv?.element
  const preview = internal?.preview?.element
  const previewContent = internal?.preview?.previewElement
  return source instanceof HTMLElement && preview instanceof HTMLElement
    ? {
        source,
        preview,
        previewContent:
          previewContent instanceof HTMLElement ? previewContent : null,
      }
    : null
}

export function indentVditorList(
  internal: any,
  item: HTMLElement,
  range: Range
): void {
  listIndent(internal, item, range)
}

export function outdentVditorList(
  internal: any,
  item: HTMLElement,
  range: Range,
  list: HTMLElement
): void {
  listOutdent(internal, item, range, list)
}

export function focusVditorRange(range: Range): void {
  setSelectionFocus(range)
}

/** Commits a DOM edit that intentionally bypasses Vditor's WYSIWYG input parser. */
export function commitVditorWysiwygDomEdit(internal: any): void {
  if (!internal || internal.currentMode !== 'wysiwyg') return
  commitWysiwygAfterRender(internal, {
    enableAddUndoStack: true,
    enableHint: false,
    enableInput: true,
  })
}

export const vditorTableActions = {
  deleteColumn,
  deleteRow,
  execAfterRender,
  insertColumn,
  insertRow,
  insertRowAbove,
}
