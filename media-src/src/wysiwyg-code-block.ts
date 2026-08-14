import { t } from './lang'
import {
  commitVditorWysiwygDomEdit,
  getVditorInternals,
  refreshVditorWysiwygCodePreview,
} from './vditor-adapter'
import { showWysiwygSourcePopover } from './wysiwyg-popover'

const ORDINARY_CLASS = 'vmd-code-block--ordinary'
const RICH_CLASS = 'vmd-code-block--rich'
const TOOLBAR_CLASS = 'vmd-code-toolbar'
const LANGUAGE_BUTTON_CLASS = 'vmd-code-language-button'
const EDIT_BUTTON_CLASS = 'vmd-source-edit-button'
const ZERO_WIDTH_SPACE = '\u200b'

const SPECIAL_LANGUAGES = new Set([
  'abc',
  'plantuml',
  'mermaid',
  'flowchart',
  'echarts',
  'mindmap',
  'graphviz',
  'math',
  'markmap',
  'smiles',
])

interface CodeBlockParts {
  block: HTMLElement
  source: HTMLElement
  sourceCode: HTMLElement
  preview: HTMLElement
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

function getCodeBlockParts(block: HTMLElement): CodeBlockParts | null {
  if (block.getAttribute('data-type') !== 'code-block') return null
  const source = block.querySelector<HTMLElement>(
    ':scope > pre:not(.vditor-wysiwyg__preview)'
  )
  const sourceCode = source?.querySelector<HTMLElement>(':scope > code') ?? null
  const preview = block.querySelector<HTMLElement>(
    ':scope > .vditor-wysiwyg__preview'
  )
  return source && sourceCode && preview
    ? { block, source, sourceCode, preview }
    : null
}

function languageFromCode(code: HTMLElement): string {
  const match = /(?:^|\s)language-([^\s]+)/.exec(code.className)
  return match?.[1] || ''
}

function languageLabel(language: string): string {
  return language || t('plainTextCode')
}

function normalizeLanguage(value: string): string | null {
  const language = value.trim()
  if (
    /[\s`]/.test(language) ||
    Array.from(language).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  ) {
    return null
  }
  return language
}

function setSourceLanguage(code: HTMLElement, language: string): void {
  const classes = Array.from(code.classList).filter(
    (className) => !className.startsWith('language-')
  )
  if (language) classes.unshift(`language-${language}`)
  code.className = classes.join(' ')
}

function isSpecialLanguage(language: string): boolean {
  return SPECIAL_LANGUAGES.has(language.toLowerCase())
}

function sourceText(sourceCode: HTMLElement): string {
  const text = (sourceCode.textContent || '').replaceAll(ZERO_WIDTH_SPACE, '')
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

function setSourceText(sourceCode: HTMLElement, value: string): void {
  sourceCode.textContent = `${value}\n`
}

function syncCopyTextarea(parts: CodeBlockParts): void {
  const textarea = parts.preview.querySelector<HTMLTextAreaElement>(
    `.${TOOLBAR_CLASS} .vditor-copy textarea`
  )
  if (textarea) textarea.value = sourceText(parts.sourceCode)
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

/** Keeps every fenced source hidden and edits ordinary/rich blocks in one popover. */
export function initWysiwygCodeBlocks(): { rebind(): void } {
  let root: HTMLElement | null = null
  let boundRoot: HTMLElement | null = null
  let observer: MutationObserver | null = null
  let refreshQueued = false
  let writing = false
  const renderTimers = new WeakMap<HTMLElement, number>()
  const renderVersions = new WeakMap<HTMLElement, number>()

  function decorateBlock(block: HTMLElement): void {
    const parts = getCodeBlockParts(block)
    if (!parts) return
    const language = languageFromCode(parts.sourceCode)
    const rich = isSpecialLanguage(language)
    parts.source.style.setProperty('display', 'none', 'important')
    block.classList.toggle(ORDINARY_CLASS, !rich)
    block.classList.toggle(RICH_CLASS, rich)

    let toolbar = parts.preview.querySelector<HTMLElement>(
      `:scope > .${TOOLBAR_CLASS}`
    )
    if (!toolbar) {
      toolbar = document.createElement('div')
      toolbar.className = TOOLBAR_CLASS
      toolbar.setAttribute('contenteditable', 'false')
      toolbar.setAttribute('data-render', '1')
      if (rich) parts.preview.appendChild(toolbar)
      else parts.preview.insertBefore(toolbar, parts.preview.firstChild)
    }

    let languageButton = toolbar.querySelector<HTMLButtonElement>(
      `:scope > .${LANGUAGE_BUTTON_CLASS}`
    )
    if (!languageButton) {
      languageButton = document.createElement('button')
      languageButton.type = 'button'
      languageButton.className = LANGUAGE_BUTTON_CLASS
      languageButton.setAttribute('contenteditable', 'false')
      languageButton.setAttribute('data-render', '1')
      toolbar.prepend(languageButton)
    }
    const label = languageLabel(language)
    if (languageButton.textContent !== label) languageButton.textContent = label
    languageButton.dataset.codeLanguage = language
    languageButton.setAttribute(
      'aria-label',
      `${t('changeCodeLanguage')}: ${label}`
    )

    let editButton = toolbar.querySelector<HTMLButtonElement>(
      `:scope > .${EDIT_BUTTON_CLASS}`
    )
    if (!editButton) {
      editButton = createEditButton()
      toolbar.appendChild(editButton)
    }

    const copy = parts.preview.querySelector<HTMLElement>(':scope > .vditor-copy')
    if (copy && copy.parentElement !== toolbar) toolbar.appendChild(copy)
    syncCopyTextarea(parts)
  }

  function refresh(): void {
    refreshQueued = false
    if (!root || writing) return
    writing = true
    try {
      root
        .querySelectorAll<HTMLElement>(
          '.vditor-wysiwyg__block[data-type="code-block"]'
        )
        .forEach(decorateBlock)
    } finally {
      writing = false
    }
  }

  function queueRefresh(): void {
    if (refreshQueued || writing) return
    refreshQueued = true
    queueMicrotask(refresh)
  }

  function schedulePreviewRender(
    parts: CodeBlockParts,
    render: () => void
  ): void {
    const previousTimer = renderTimers.get(parts.block)
    if (previousTimer !== undefined) window.clearTimeout(previousTimer)
    const version = (renderVersions.get(parts.block) ?? 0) + 1
    renderVersions.set(parts.block, version)
    const timer = window.setTimeout(() => {
      renderTimers.delete(parts.block)
      if (
        renderVersions.get(parts.block) !== version ||
        !parts.block.isConnected
      ) {
        return
      }
      render()
    }, 50)
    renderTimers.set(parts.block, timer)
  }

  function flushPreviewRender(
    parts: CodeBlockParts,
    render: () => void
  ): void {
    const timer = renderTimers.get(parts.block)
    if (timer !== undefined) window.clearTimeout(timer)
    renderTimers.delete(parts.block)
    renderVersions.set(parts.block, (renderVersions.get(parts.block) ?? 0) + 1)
    render()
  }

  function openEditor(
    parts: CodeBlockParts,
    focusField: 'language' | 'content'
  ): void {
    const popover = getSharedPopover()
    const internal = getVditorInternals()
    if (!popover || !internal || internal.currentMode !== 'wysiwyg') return
    const initialLanguage = languageFromCode(parts.sourceCode)
    const initialContent = sourceText(parts.sourceCode)

    showWysiwygSourcePopover({
      popover,
      target: parts.block,
      focusField,
      fields: [
        {
          name: 'language',
          label: t('changeCodeLanguage'),
          value: initialLanguage,
        },
        {
          name: 'content',
          label: t('codeContent') || 'Code content',
          value: initialContent,
          multiline: true,
        },
      ],
      onChange: (values) => {
        if (!parts.block.isConnected || !parts.sourceCode.isConnected) {
          return 'The code block is no longer available'
        }
        const language = normalizeLanguage(values.language ?? '')
        const content = values.content ?? ''
        if (sourceText(parts.sourceCode) !== content) {
          setSourceText(parts.sourceCode, content)
        }
        if (language === null) {
          parts.source.style.setProperty('display', 'none', 'important')
          return t('invalidCodeLanguage') || 'Language cannot contain whitespace, control characters, or backticks'
        }
        if (languageFromCode(parts.sourceCode) !== language) {
          setSourceLanguage(parts.sourceCode, language)
          internal.hint.recentLanguage = language
        }
        schedulePreviewRender(parts, () => {
          refreshVditorWysiwygCodePreview(internal, parts.source, parts.preview)
          parts.source.style.setProperty('display', 'none', 'important')
          queueRefresh()
        })
        return null
      },
      onFinish: (_values, changed) => {
        if (!changed || !parts.block.isConnected || !parts.sourceCode.isConnected) {
          return
        }
        const sourceChanged =
          languageFromCode(parts.sourceCode) !== initialLanguage ||
          sourceText(parts.sourceCode) !== initialContent
        if (!sourceChanged) return
        flushPreviewRender(parts, () => {
          refreshVditorWysiwygCodePreview(internal, parts.source, parts.preview)
        })
        parts.source.style.setProperty('display', 'none', 'important')
        commitVditorWysiwygDomEdit(internal)
        queueRefresh()
      },
    })
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
    const block = element?.closest<HTMLElement>(
      '.vditor-wysiwyg__block[data-type="code-block"]'
    )
    const parts = block ? getCodeBlockParts(block) : null
    if (!parts || !parts.source.contains(node)) return
    parts.source.style.setProperty('display', 'none', 'important')
    openEditor(parts, 'content')
  }

  function onRootPointerDown(event: PointerEvent): void {
    const target = event.target instanceof Element ? event.target : null
    if (!target?.closest(`.${LANGUAGE_BUTTON_CLASS}, .${EDIT_BUTTON_CLASS}`)) {
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function onRootClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null
    const block = target?.closest<HTMLElement>(
      '.vditor-wysiwyg__block[data-type="code-block"]'
    )
    const parts = block ? getCodeBlockParts(block) : null
    if (!target || !parts) return

    const languageButton = target.closest(`.${LANGUAGE_BUTTON_CLASS}`)
    const editButton = target.closest(`.${EDIT_BUTTON_CLASS}`)
    const ordinaryPreviewClick =
      parts.block.classList.contains(ORDINARY_CLASS) &&
      parts.preview.contains(target) &&
      !target.closest('.vditor-copy')
    if (!languageButton && !editButton && !ordinaryPreviewClick) {
      if (
        parts.block.classList.contains(RICH_CLASS) &&
        parts.preview.contains(target)
      ) {
        // Keep diagram controls interactive without letting Vditor expose the
        // hidden source or move the caret into it.
        event.stopImmediatePropagation()
      }
      return
    }

    event.preventDefault()
    event.stopImmediatePropagation()
    openEditor(parts, languageButton ? 'language' : 'content')
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
