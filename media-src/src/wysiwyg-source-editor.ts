import { t } from './lang'
import {
  commitVditorWysiwygDomEdit,
  getVditorInternals,
  refreshVditorWysiwygHtmlPreview,
  refreshVditorWysiwygMathPreview,
} from './vditor-adapter'
import { showWysiwygSourcePopover } from './wysiwyg-popover'

const EDIT_BUTTON_CLASS = 'vmd-source-edit-button'
const INLINE_CONTROL_CLASS = 'vmd-inline-source-control'
const ZERO_WIDTH_SPACE = '\u200b'

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

function getWysiwygRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '.vditor-wysiwyg .vditor-reset'
  )
}

function getSharedPopover(): HTMLElement | null {
  const popover = getVditorInternals()?.wysiwyg?.popover
  return popover instanceof HTMLElement ? popover : null
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

  if (type !== 'math-block' && type !== 'math-inline' && type !== 'html-block' && type !== 'html-entity') {
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

function createEditButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = EDIT_BUTTON_CLASS
  button.setAttribute('contenteditable', 'false')
  button.setAttribute('data-render', '1')
  button.setAttribute('aria-label', t('editSource') || 'Edit source')
  button.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.7 1.8a1.4 1.4 0 0 1 2 2l-8.4 8.4-3 .6.6-3 8.8-8z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>'
  return button
}

function ensureInlineControl(source: HTMLElement): void {
  const existing = source.nextElementSibling
  if (existing?.classList.contains(INLINE_CONTROL_CLASS)) return
  const control = document.createElement('span')
  control.className = INLINE_CONTROL_CLASS
  control.setAttribute('contenteditable', 'false')
  control.setAttribute('data-render', '1')
  control.appendChild(createEditButton())
  source.insertAdjacentElement('afterend', control)
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
export function initWysiwygSourceEditors(): { rebind(): void } {
  let root: HTMLElement | null = null
  let boundRoot: HTMLElement | null = null
  let observer: MutationObserver | null = null
  let refreshQueued = false
  let writing = false

  function decorate(): void {
    refreshQueued = false
    if (!root || writing) return
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
          parts.source.style.setProperty('display', 'none', 'important')
          owner.classList.add('vmd-source-owned')
          // Alert recognition projects HTML previews to determine whether a
          // quote has a rendered body. Controls inside that clone would turn a
          // comment-only quote into an Alert, so do not decorate quote HTML.
          if (owner.closest('blockquote')) return
          if (parts.kind === 'html-block' && parts.preview) {
            parts.preview.classList.add('vmd-html-transparent-preview')
            if (!parts.preview.querySelector(`:scope > .${EDIT_BUTTON_CLASS}`)) {
              parts.preview.appendChild(createEditButton())
            }
          }
          if (parts.kind === 'html-inline') ensureInlineControl(parts.source)
        })
    } finally {
      writing = false
    }
  }

  function queueRefresh(): void {
    if (refreshQueued || writing) return
    refreshQueued = true
    queueMicrotask(decorate)
  }

  function refreshPreview(parts: SourceParts, value: string): string | null {
    const internal = getVditorInternals()
    if (!internal || internal.currentMode !== 'wysiwyg') {
      return 'The visual editor is no longer active'
    }
    if (parts.kind === 'math-block' || parts.kind === 'math-inline') {
      return parts.preview && refreshVditorWysiwygMathPreview(
        internal,
        parts.source,
        parts.preview,
        value
      )
        ? null
        : 'Unable to refresh the formula preview'
    }
    if (parts.kind === 'html-block') {
      return parts.preview && refreshVditorWysiwygHtmlPreview(
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
    const popover = getSharedPopover()
    const internal = getVditorInternals()
    if (!popover || !internal || internal.currentMode !== 'wysiwyg') return
    const initial = cleanSourceText(parts.code)
    const multiline = parts.kind === 'math-block' || parts.kind === 'html-block'

    showWysiwygSourcePopover({
      popover,
      target: parts.owner,
      focusField: 'source',
      fields: [
        {
          name: 'source',
          label: t(`edit${parts.kind}`) || t('editSource') || 'Edit source',
          value: initial,
          multiline,
        },
      ],
      onChange: (values) => {
        if (!parts.owner.isConnected || !parts.code.isConnected) {
          return 'The source element is no longer available'
        }
        const value = values.source ?? ''
        if (parts.kind === 'html-entity' && decodeHtmlEntity(value) === null) {
          return 'Enter one complete HTML entity'
        }
        if (parts.kind === 'html-inline' && !validateInlineHtml(value)) {
          return 'Enter one complete inline HTML tag'
        }
        writeSourceText(parts.code, value)
        parts.source.style.setProperty('display', 'none', 'important')
        const error = refreshPreview(parts, value)
        queueRefresh()
        return error
      },
      onFinish: (_values, changed) => {
        if (
          !changed ||
          !parts.owner.isConnected ||
          !parts.code.isConnected ||
          cleanSourceText(parts.code) === initial
        ) {
          return
        }
        parts.source.style.setProperty('display', 'none', 'important')
        commitVditorWysiwygDomEdit(internal)
        queueRefresh()
      },
    })
  }

  function eventParts(target: Element): SourceParts | null {
    const inlineControl = target.closest(`.${INLINE_CONTROL_CLASS}`)
    if (inlineControl?.previousElementSibling instanceof HTMLElement) {
      return sourcePartsForOwner(inlineControl.previousElementSibling)
    }
    const owner = target.closest<HTMLElement>(
      '.vditor-wysiwyg__block[data-type="math-block"], ' +
        '.vditor-wysiwyg__block[data-type="html-block"], ' +
        'span.vditor-wysiwyg__block[data-type="math-inline"], ' +
        'span.vditor-wysiwyg__block[data-type="html-entity"]'
    )
    return owner ? sourcePartsForOwner(owner) : null
  }

  function shouldOpen(parts: SourceParts, target: Element): boolean {
    if (target.closest(`.${INLINE_CONTROL_CLASS}`)) return true
    if (parts.kind === 'html-block') {
      return !!target.closest(`.${EDIT_BUTTON_CLASS}`)
    }
    return !!parts.preview?.contains(target)
  }

  function onSelectionChange(): void {
    if (
      !root ||
      document.activeElement?.closest('.vmd-source-popover')
    ) {
      return
    }
    const selection = window.getSelection()
    if (!selection?.rangeCount) return
    const node = selection.getRangeAt(0).startContainer
    const element = node instanceof Element ? node : node.parentElement
    const owner = element?.closest<HTMLElement>(
      '.vditor-wysiwyg__block[data-type="math-block"], ' +
        '.vditor-wysiwyg__block[data-type="html-block"], ' +
        'span.vditor-wysiwyg__block[data-type="math-inline"], ' +
        'span.vditor-wysiwyg__block[data-type="html-entity"], ' +
        'code[data-type="html-inline"]'
    )
    const parts = owner ? sourcePartsForOwner(owner) : null
    if (!parts || !parts.source.contains(node)) return
    parts.source.style.setProperty('display', 'none', 'important')
    openEditor(parts)
  }

  function onRootPointerDown(event: PointerEvent): void {
    const target = event.target instanceof Element ? event.target : null
    const parts = target ? eventParts(target) : null
    if (!target || !parts || !shouldOpen(parts, target)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function onRootClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null
    const parts = target ? eventParts(target) : null
    if (!target || !parts) return
    if (!shouldOpen(parts, target)) {
      if (parts.kind === 'html-block' && parts.preview?.contains(target)) {
        // Preserve links, details, media, and form defaults while stopping
        // Vditor's bubbling handler from moving the caret into hidden HTML.
        event.stopImmediatePropagation()
      }
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    openEditor(parts)
  }

  function unbindRoot(): void {
    observer?.disconnect()
    observer = null
    if (!boundRoot) return
    boundRoot.removeEventListener('pointerdown', onRootPointerDown, true)
    boundRoot.removeEventListener('click', onRootClick, true)
    boundRoot = null
  }

  function rebind(): void {
    const nextRoot = getWysiwygRoot()
    if (nextRoot === root && boundRoot === nextRoot) {
      queueRefresh()
      return
    }
    unbindRoot()
    root = nextRoot
    if (!root) return
    boundRoot = root
    root.addEventListener('pointerdown', onRootPointerDown, true)
    root.addEventListener('click', onRootClick, true)
    observer = new MutationObserver(queueRefresh)
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    queueRefresh()
  }

  document.addEventListener('selectionchange', onSelectionChange)
  rebind()
  return { rebind }
}
