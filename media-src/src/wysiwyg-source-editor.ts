import { t } from './lang'
import {
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

/** Moves formula, raw HTML, inline HTML and entity source into the shared popover. */
export function initWysiwygSourceEditors(): void {
  let writing = false

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

  function eventParts(event: MouseEvent, target: Element): SourceParts | null {
    const owner = target.closest<HTMLElement>(
      '.vditor-wysiwyg__block[data-type="math-block"], ' +
        '.vditor-wysiwyg__block[data-type="html-block"], ' +
        'span.vditor-wysiwyg__block[data-type="math-inline"], ' +
        'span.vditor-wysiwyg__block[data-type="html-entity"]'
    )
    return owner
      ? sourcePartsForOwner(owner)
      : nearestInlineHtmlParts(event, target)
  }

  function shouldOpen(parts: SourceParts, target: Element): boolean {
    if (parts.kind === 'html-block' || parts.kind === 'html-inline') {
      const interactive = target.closest(INTERACTIVE_HTML_SELECTOR)
      const interactionScope = parts.kind === 'html-block'
        ? parts.preview
        : target.closest<HTMLElement>(INLINE_HTML_SCOPE_SELECTOR)
      if (interactive && interactionScope?.contains(interactive)) return false
    }
    return parts.kind === 'html-inline' || !!parts.preview?.contains(target)
  }

  const registration = registerWysiwygDomFeature({
    refresh,
    onPointerDown: (event) => {
      const target = event.target instanceof Element ? event.target : null
      const parts = target ? eventParts(event, target) : null
      if (!target || !parts || !shouldOpen(parts, target)) return false
      event.preventDefault()
      event.stopImmediatePropagation()
      return true
    },
    onClick: (event) => {
      const target = event.target instanceof Element ? event.target : null
      const parts = target ? eventParts(event, target) : null
      if (!target || !parts || !shouldOpen(parts, target)) return false
      event.preventDefault()
      event.stopImmediatePropagation()
      openEditor(parts)
      return true
    },
  })
}
