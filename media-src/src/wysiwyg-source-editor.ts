import { t } from './lang'
import {
  focusVditorRange,
  getVditorInternals,
  refreshVditorWysiwygHtmlPreview,
  refreshVditorWysiwygMathPreview,
} from './vditor-adapter'
import { registerWysiwygDomFeature } from './wysiwyg-dom'
import {
  hideWysiwygSerializerSource,
  openWysiwygSourceEditSession,
} from './wysiwyg-popover'

const ZERO_WIDTH_SPACE = '\u200b'
const INLINE_HTML_SCOPE_SELECTOR =
  'p, h1, h2, h3, h4, h5, h6, li, td, th, figcaption, blockquote'
const INTERACTIVE_HTML_SELECTOR =
  'a, button, input, select, textarea, details, summary, audio, video, img, iframe, [contenteditable="true"]'

type SourceKind =
  | 'math-block'
  | 'math-inline'
  | 'html-block'
  | 'html-inline'
  | 'html-entity'

interface SourceParts {
  kind: SourceKind
  owner: HTMLElement
  source: HTMLElement
  code: HTMLElement
  preview: HTMLElement | null
}

let openBlockEditor: ((owner: HTMLElement) => boolean) | null = null

export function openWysiwygBlockSourceEditor(owner: HTMLElement): boolean {
  return openBlockEditor?.(owner) ?? false
}

function cleanSourceText(code: HTMLElement): string {
  const value = code.textContent || ''
  return value.startsWith(ZERO_WIDTH_SPACE) ? value.slice(1) : value
}

function writeSourceText(code: HTMLElement, value: string): void {
  const prefix = (code.textContent || '').startsWith(ZERO_WIDTH_SPACE)
    ? ZERO_WIDTH_SPACE
    : ''
  code.textContent = `${prefix}${value}`
}

function sourcePartsForOwner(owner: HTMLElement): SourceParts | null {
  const type = owner.getAttribute('data-type') as SourceKind | null
  if (!type) return null

  if (type === 'html-inline') {
    return owner.matches('code[data-type="html-inline"]')
      ? { kind: type, owner, source: owner, code: owner, preview: null }
      : null
  }

  if (
    type !== 'math-block' &&
    type !== 'math-inline' &&
    type !== 'html-block' &&
    type !== 'html-entity'
  ) {
    return null
  }
  const preview = owner.querySelector<HTMLElement>(
    ':scope > .vditor-wysiwyg__preview'
  )
  const source = preview?.previousElementSibling
  if (!(source instanceof HTMLElement)) return null
  const code = source.matches('code')
    ? source
    : source.querySelector<HTMLElement>(':scope > code')
  return code ? { kind: type, owner, source, code, preview } : null
}

function sourceEditLabel(): string {
  return t('editSource') || 'Edit source'
}

function decodeHtmlEntity(value: string): string | null {
  if (!/^&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);$/i.test(value)) {
    return null
  }
  const textarea = document.createElement('textarea')
  textarea.innerHTML = value
  return textarea.value
}

function validateInlineHtml(value: string): boolean {
  return (
    /^<[^\r\n<>]+>$/.test(value.trim()) &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 && character !== '\t'
    })
  )
}

/** Moves serializer-owned source into the shared explicit editing popover. */
export function initWysiwygSourceEditors(): void {
  let writing = false
  let suppressedInlineClick: HTMLElement | null = null

  function refresh(root: HTMLElement): void {
    if (writing) return
    writing = true
    try {
      root
        .querySelectorAll<HTMLElement>(
          '.vditor-wysiwyg__block[data-type="math-block"], ' +
            '.vditor-wysiwyg__block[data-type="html-block"], ' +
            'span.vditor-wysiwyg__block[data-type="math-inline"], ' +
            'span.vditor-wysiwyg__block[data-type="html-entity"], ' +
            'code[data-type="html-inline"]'
        )
        .forEach((owner) => {
          const parts = sourcePartsForOwner(owner)
          if (!parts) return
          hideWysiwygSerializerSource(parts.source)
          owner.classList.add('vmd-source-owned')
          if (parts.kind === 'html-block' && parts.preview) {
            parts.preview.classList.add('vmd-html-transparent-preview')
          }
        })
    } finally {
      writing = false
    }
  }

  function refreshPreview(parts: SourceParts, value: string): string | null {
    const internal = getVditorInternals()
    if (!internal || internal.currentMode !== 'wysiwyg') {
      return 'The visual editor is no longer active'
    }
    if (parts.kind === 'math-block' || parts.kind === 'math-inline') {
      return parts.preview &&
        refreshVditorWysiwygMathPreview(
          internal,
          parts.source,
          parts.preview,
          value
        )
        ? null
        : 'Unable to refresh the formula preview'
    }
    if (parts.kind === 'html-block') {
      return parts.preview &&
        refreshVditorWysiwygHtmlPreview(
          internal,
          parts.owner,
          value,
          parts.preview
        )
        ? null
        : 'HTML does not form a renderable block'
    }
    if (parts.kind === 'html-entity') {
      const decoded = decodeHtmlEntity(value)
      if (decoded === null) return 'Enter one complete HTML entity'
      const rendered = parts.preview?.querySelector<HTMLElement>(':scope > code')
      if (!rendered) return 'Unable to refresh the HTML entity preview'
      rendered.textContent = decoded
    }
    return null
  }

  function openEditor(parts: SourceParts): void {
    const initial = cleanSourceText(parts.code)
    const multiline = parts.kind === 'math-block' || parts.kind === 'html-block'

    openWysiwygSourceEditSession({
      target: parts.owner,
      focusField: 'source',
      placement: parts.kind === 'html-block'
        ? 'html-block'
        : parts.kind === 'math-block'
          ? 'math-block'
          : undefined,
      fields: [
        {
          name: 'source',
          label: t(`edit${parts.kind}`) || sourceEditLabel(),
          value: initial,
          multiline,
        },
      ],
      unavailableMessage: 'The source element is no longer available',
      isAvailable: () => parts.code.isConnected,
      onChange: (values) => {
        const value = values.source ?? ''
        if (parts.kind === 'html-entity' && decodeHtmlEntity(value) === null) {
          return 'Enter one complete HTML entity'
        }
        if (parts.kind === 'html-inline' && !validateInlineHtml(value)) {
          return 'Enter one complete inline HTML tag'
        }
        writeSourceText(parts.code, value)
        hideWysiwygSerializerSource(parts.source)
        const error = refreshPreview(parts, value)
        registration.requestRefresh()
        return error
      },
      isSourceChanged: () => cleanSourceText(parts.code) !== initial,
      beforeCommit: () => hideWysiwygSerializerSource(parts.source),
      afterCommit: () => registration.requestRefresh(),
    })
  }

  openBlockEditor = (owner) => {
    const parts = sourcePartsForOwner(owner)
    if (
      !parts ||
      (parts.kind !== 'html-block' && parts.kind !== 'math-block') ||
      !owner.isConnected ||
      !parts.preview
    ) {
      return false
    }
    openEditor(parts)
    return true
  }

  function textOffsetAt(
    scope: HTMLElement,
    node: Node,
    offset: number
  ): number | null {
    if (node !== scope && !scope.contains(node)) return null
    const range = document.createRange()
    range.selectNodeContents(scope)
    try {
      range.setEnd(node, offset)
      return range.toString().length
    } catch {
      return null
    }
  }

  function nearestInlineHtmlParts(
    event: MouseEvent,
    target: Element
  ): SourceParts | null {
    const scope = target.closest<HTMLElement>(INLINE_HTML_SCOPE_SELECTOR)
    if (!scope) return null
    const tokens = Array.from(
      scope.querySelectorAll<HTMLElement>('code[data-type="html-inline"]')
    )
    if (tokens.length === 0) return null

    const pointRange = document.caretRangeFromPoint?.(
      event.clientX,
      event.clientY
    )
    const selection = window.getSelection()
    const selectedRange = selection?.rangeCount ? selection.getRangeAt(0) : null
    const referenceRange =
      pointRange && scope.contains(pointRange.startContainer)
        ? pointRange
        : selectedRange && scope.contains(selectedRange.startContainer)
          ? selectedRange
          : null
    const referenceOffset = referenceRange
      ? textOffsetAt(
          scope,
          referenceRange.startContainer,
          referenceRange.startOffset
        )
      : null
    if (referenceOffset === null) return sourcePartsForOwner(tokens[0])

    let nearest = tokens[0]
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const token of tokens) {
      const parent = token.parentNode
      if (!parent) continue
      const index = Array.from(parent.childNodes).indexOf(token)
      const before = textOffsetAt(scope, parent, index)
      const after = textOffsetAt(scope, parent, index + 1)
      if (before === null || after === null) continue
      const distance = Math.abs(referenceOffset - (before + after) / 2)
      if (distance < nearestDistance) {
        nearest = token
        nearestDistance = distance
      }
    }
    return sourcePartsForOwner(nearest)
  }

  const directlyEditableOwnerSelector =
    'span.vditor-wysiwyg__block[data-type="math-inline"], ' +
    'span.vditor-wysiwyg__block[data-type="html-entity"]'

  function eventParts(event: MouseEvent, target: Element): SourceParts | null {
    const owner = target.closest<HTMLElement>(directlyEditableOwnerSelector)
    return owner
      ? sourcePartsForOwner(owner)
      : nearestInlineHtmlParts(event, target)
  }

  function selectionInlinePreviewParts(): SourceParts | null {
    const selection = window.getSelection()
    const range = selection?.rangeCount === 1
      ? selection.getRangeAt(0)
      : null
    if (!range) return null
    const element = range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement
    const owner = element?.closest<HTMLElement>(
      'span.vditor-wysiwyg__block[data-type="math-inline"], ' +
        'span.vditor-wysiwyg__block[data-type="html-entity"]'
    )
    const parts = owner ? sourcePartsForOwner(owner) : null
    return parts?.preview?.contains(range.startContainer) ? parts : null
  }

  function inlineCaretPlacement(
    parts: SourceParts,
    event: PointerEvent
  ): 'before' | 'after' | null {
    if (parts.kind !== 'math-inline' && parts.kind !== 'html-entity') return null
    const rect = parts.owner.getBoundingClientRect()
    if (rect.width <= 0) return null
    if (event.clientX <= rect.left + rect.width / 4) return 'before'
    if (event.clientX >= rect.right - rect.width / 4) return 'after'
    return null
  }

  function placeCaretNextToInline(
    parts: SourceParts,
    placement: 'before' | 'after'
  ): void {
    const range = document.createRange()
    range.selectNode(parts.owner)
    range.collapse(placement === 'before')
    focusVditorRange(range)
  }

  function shouldOpen(parts: SourceParts, target: Element): boolean {
    if (parts.kind === 'html-inline') {
      const interactive = target.closest(INTERACTIVE_HTML_SELECTOR)
      const interactionScope = target.closest<HTMLElement>(
        INLINE_HTML_SCOPE_SELECTOR
      )
      if (interactive && interactionScope?.contains(interactive)) return false
      return true
    }
    return !!parts.preview?.contains(target)
  }

  const registration = registerWysiwygDomFeature({
    refresh,
    beforeRebind: () => {
      suppressedInlineClick = null
    },
    onPointerDown: (event) => {
      suppressedInlineClick = null
      const target = event.target instanceof Element ? event.target : null
      const parts = target ? eventParts(event, target) : null
      if (!target || !parts || !shouldOpen(parts, target)) return false

      const placement = event.button === 0
        ? inlineCaretPlacement(parts, event)
        : null
      if (placement) {
        event.preventDefault()
        event.stopImmediatePropagation()
        suppressedInlineClick = parts.owner
        placeCaretNextToInline(parts, placement)
        return true
      }

      event.preventDefault()
      event.stopImmediatePropagation()
      return true
    },
    onClick: (event) => {
      const target = event.target instanceof Element ? event.target : null
      if (
        target &&
        suppressedInlineClick &&
        (target === suppressedInlineClick || suppressedInlineClick.contains(target))
      ) {
        suppressedInlineClick = null
        event.preventDefault()
        event.stopImmediatePropagation()
        return true
      }
      suppressedInlineClick = null

      if (
        target &&
        !target.closest(directlyEditableOwnerSelector) &&
        selectionInlinePreviewParts()
      ) {
        // A click in the line beside an inline render can leave Chromium's
        // native caret in its preview. Do not let Vditor's bubbling click
        // handler transfer that caret into the hidden serializer source.
        event.stopImmediatePropagation()
        return true
      }

      const parts = target ? eventParts(event, target) : null
      if (!target || !parts || !shouldOpen(parts, target)) return false
      event.preventDefault()
      event.stopImmediatePropagation()
      openEditor(parts)
      return true
    },
    dispose: () => {
      suppressedInlineClick = null
      openBlockEditor = null
    },
  })
}
