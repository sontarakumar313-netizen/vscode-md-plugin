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
import { setEditMode } from 'vditor/src/ts/toolbar/EditMode'
import { afterRenderEvent as commitWysiwygAfterRender } from 'vditor/src/ts/wysiwyg/afterRenderEvent'
import { renderDomByMd } from 'vditor/src/ts/wysiwyg/renderDomByMd'
import { processCodeRender } from 'vditor/src/ts/util/processCode'
import { mathRender } from 'vditor/src/ts/markdown/mathRender'
import { renderToc } from 'vditor/src/ts/util/toc'
import {
  genAPopover,
  highlightToolbarWYSIWYG,
} from 'vditor/src/ts/wysiwyg/highlightToolbarWYSIWYG'

type VditorInternals = Parameters<typeof genAPopover>[0]

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

/** Cancels Vditor's delayed contextual-toolbar refresh for the active panel. */
export function cancelPendingVditorWysiwygToolbar(
  popover: HTMLElement
): void {
  const internal = getVditorInternals()
  if (
    !internal ||
    internal.currentMode !== 'wysiwyg' ||
    internal.wysiwyg?.popover !== popover
  ) {
    return
  }
  window.clearTimeout(internal.wysiwyg.hlToolbarTimeoutId)
}

/** Switches between the two supported modes without exposing Vditor shortcuts. */
export function switchVditorMode(
  editor: unknown,
  mode: VditorMode
): boolean {
  const internal = getVditorInternals(editor)
  if (!internal) return false
  if (getVditorMode(editor) === mode) return true

  setEditMode(
    internal,
    mode,
    new Event('vmd-edit-mode', { bubbles: false, cancelable: true })
  )
  return getVditorMode(editor) === mode
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

/** Opens an existing link's popover without Vditor's 200 ms toolbar debounce. */
export function showVditorWysiwygLinkPopover(
  internal: VditorInternals | null,
  link: HTMLElement
): boolean {
  if (
    !internal ||
    internal.currentMode !== 'wysiwyg' ||
    !internal.wysiwyg.element.contains(link)
  ) {
    return false
  }
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return false

  window.clearTimeout(internal.wysiwyg.hlToolbarTimeoutId)
  genAPopover(internal, link, selection.getRangeAt(0))
  return true
}

/** Refreshes Vditor's native contextual popover for the current WYSIWYG caret. */
export function refreshVditorWysiwygToolbar(internal: any): void {
  if (!internal || internal.currentMode !== 'wysiwyg') return
  highlightToolbarWYSIWYG(internal)
}

export function setVditorMarkdown(editor: any, markdown: string): void {
  const internal = getVditorInternals(editor)
  const mode = getVditorMode(editor)
  if (!internal || !mode) return

  if (mode === 'wysiwyg') {
    renderDomByMd(internal, markdown, {
      enableAddUndoStack: true,
      enableHint: false,
      enableInput: false,
    })
    return
  }
  editor.setValue(markdown)
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

/** Commits a heading-level DOM replacement and refreshes the outline. */
export function commitVditorWysiwygHeadingEdit(editor: unknown): boolean {
  const internal = getVditorInternals(editor)
  if (!internal || internal.currentMode !== 'wysiwyg') return false
  renderToc(internal)
  commitVditorWysiwygDomEdit(internal)
  return true
}

/** Rebuilds one ordinary code preview from its serializer-owned source node. */
export function refreshVditorWysiwygCodePreview(
  internal: Parameters<typeof processCodeRender>[1] | null,
  source: HTMLElement,
  preview: HTMLElement
): boolean {
  if (
    !internal ||
    internal.currentMode !== 'wysiwyg' ||
    !internal.wysiwyg?.element?.contains(source) ||
    source.nextElementSibling !== preview
  ) {
    return false
  }
  preview.innerHTML = source.innerHTML
  preview.setAttribute('data-render', '2')
  processCodeRender(preview, internal)
  return true
}

interface HtmlPreviewInternals {
  currentMode?: string
  lute?: { Md2VditorDOM(markdown: string): string }
  wysiwyg?: { element?: HTMLElement }
}

/** Re-parses one raw HTML block with the configured, sanitized Lute instance. */
export function refreshVditorWysiwygHtmlPreview(
  internal: HtmlPreviewInternals | null,
  block: HTMLElement,
  source: string,
  preview: HTMLElement
): boolean {
  if (
    internal?.currentMode !== 'wysiwyg' ||
    typeof internal.lute?.Md2VditorDOM !== 'function' ||
    !internal.wysiwyg?.element?.contains(block)
  ) {
    return false
  }
  const parsed = document.createElement('div')
  parsed.innerHTML = internal.lute.Md2VditorDOM(source)
  const nextPreview = parsed.querySelector<HTMLElement>(
    '.vditor-wysiwyg__block[data-type="html-block"] > .vditor-wysiwyg__preview'
  )
  if (!nextPreview) return false
  preview.replaceChildren(...Array.from(nextPreview.childNodes))
  preview.setAttribute('data-render', '1')
  return true
}

interface MathPreviewInternals {
  currentMode?: string
  options?: Parameters<typeof mathRender>[1] & { preview?: { math?: IMath } }
  wysiwyg?: { element?: HTMLElement }
}

/** Refreshes an inline or display formula while retaining its source element. */
export function refreshVditorWysiwygMathPreview(
  internal: MathPreviewInternals | null,
  source: HTMLElement,
  preview: HTMLElement,
  value: string
): boolean {
  if (
    internal?.currentMode !== 'wysiwyg' ||
    !internal.wysiwyg?.element?.contains(source) ||
    source.nextElementSibling !== preview
  ) {
    return false
  }
  const math = preview.querySelector<HTMLElement>('.language-math')
  if (!math) return false
  math.className = 'language-math'
  math.removeAttribute('data-math')
  math.textContent = value
  mathRender(preview, {
    cdn: internal.options?.cdn,
    math: internal.options?.preview?.math,
  })
  preview.setAttribute('data-render', '1')
  return true
}

export const vditorTableActions = {
  deleteColumn,
  deleteRow,
  execAfterRender,
  insertColumn,
  insertRow,
  insertRowAbove,
}
