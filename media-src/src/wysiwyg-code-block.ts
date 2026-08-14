import { t } from './lang'
import {
  getVditorInternals,
  refreshVditorWysiwygCodePreview,
} from './vditor-adapter'
import { registerWysiwygDomFeature } from './wysiwyg-dom'
import {
  WYSIWYG_SOURCE_EDIT_BUTTON_CLASS,
  createWysiwygSourceEditButton,
  hideWysiwygSerializerSource,
  openWysiwygSourceEditSession,
} from './wysiwyg-popover'

const ORDINARY_CLASS = 'vmd-code-block--ordinary'
const RICH_CLASS = 'vmd-code-block--rich'
const TOOLBAR_CLASS = 'vmd-code-toolbar'
const ACTIONS_CLASS = 'vmd-code-toolbar__actions'
const LANGUAGE_CLASS = 'vmd-code-language'
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

/** Keeps every fenced source hidden and edits ordinary/rich blocks in one popover. */
export function initWysiwygCodeBlocks(): void {
  let writing = false
  const renderTimers = new WeakMap<HTMLElement, number>()
  const renderVersions = new WeakMap<HTMLElement, number>()

  function decorateBlock(block: HTMLElement): void {
    const parts = getCodeBlockParts(block)
    if (!parts) return
    const language = languageFromCode(parts.sourceCode)
    const rich = isSpecialLanguage(language)
    hideWysiwygSerializerSource(parts.source)
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

    let languageElement = toolbar.querySelector<HTMLElement>(
      `:scope > .${LANGUAGE_CLASS}`
    )
    if (!languageElement) {
      languageElement = document.createElement('span')
      languageElement.className = LANGUAGE_CLASS
      languageElement.setAttribute('contenteditable', 'false')
      languageElement.setAttribute('data-render', '1')
      toolbar.prepend(languageElement)
    }
    const label = languageLabel(language)
    if (languageElement.textContent !== label) languageElement.textContent = label
    languageElement.dataset.codeLanguage = language

    let actions = toolbar.querySelector<HTMLElement>(
      `:scope > .${ACTIONS_CLASS}`
    )
    if (!actions) {
      actions = document.createElement('div')
      actions.className = ACTIONS_CLASS
      actions.setAttribute('contenteditable', 'false')
      actions.setAttribute('data-render', '1')
      toolbar.appendChild(actions)
    }

    let editButton = toolbar.querySelector<HTMLButtonElement>(
      `.${WYSIWYG_SOURCE_EDIT_BUTTON_CLASS}`
    )
    if (!editButton) {
      editButton = createWysiwygSourceEditButton(
        t('editSource') || 'Edit source'
      )
    }
    if (editButton.parentElement !== actions) actions.appendChild(editButton)

    const copy = parts.preview.querySelector<HTMLElement>(':scope > .vditor-copy')
    if (copy && copy.parentElement !== actions) actions.appendChild(copy)
    syncCopyTextarea(parts)
  }

  function refresh(root: HTMLElement): void {
    if (writing) return
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
    const internal = getVditorInternals()
    if (!internal || internal.currentMode !== 'wysiwyg') return
    const initialLanguage = languageFromCode(parts.sourceCode)
    const initialContent = sourceText(parts.sourceCode)

    openWysiwygSourceEditSession({
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
      unavailableMessage: 'The code block is no longer available',
      isAvailable: () => parts.sourceCode.isConnected,
      onChange: (values) => {
        const language = normalizeLanguage(values.language ?? '')
        const content = values.content ?? ''
        if (sourceText(parts.sourceCode) !== content) {
          setSourceText(parts.sourceCode, content)
        }
        if (language === null) {
          hideWysiwygSerializerSource(parts.source)
          return (
            t('invalidCodeLanguage') ||
            'Language cannot contain whitespace, control characters, or backticks'
          )
        }
        if (languageFromCode(parts.sourceCode) !== language) {
          setSourceLanguage(parts.sourceCode, language)
          internal.hint.recentLanguage = language
        }
        schedulePreviewRender(parts, () => {
          refreshVditorWysiwygCodePreview(
            internal,
            parts.source,
            parts.preview
          )
          hideWysiwygSerializerSource(parts.source)
          registration.requestRefresh()
        })
        return null
      },
      isSourceChanged: () =>
        languageFromCode(parts.sourceCode) !== initialLanguage ||
        sourceText(parts.sourceCode) !== initialContent,
      beforeCommit: () => {
        flushPreviewRender(parts, () => {
          refreshVditorWysiwygCodePreview(
            internal,
            parts.source,
            parts.preview
          )
        })
        hideWysiwygSerializerSource(parts.source)
      },
      afterCommit: () => registration.requestRefresh(),
    })
  }

  const registration = registerWysiwygDomFeature({
    refresh,
    onPointerDown: (event) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target?.closest(`.${WYSIWYG_SOURCE_EDIT_BUTTON_CLASS}`)) {
        return false
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      return true
    },
    onClick: (event) => {
      const target = event.target instanceof Element ? event.target : null
      const block = target?.closest<HTMLElement>(
        '.vditor-wysiwyg__block[data-type="code-block"]'
      )
      const parts = block ? getCodeBlockParts(block) : null
      if (!target || !parts) return false

      if (target.closest('.vditor-copy')) return false
      const editButton = target.closest(
        `.${WYSIWYG_SOURCE_EDIT_BUTTON_CLASS}`
      )
      if (!editButton) {
        if (parts.preview.contains(target)) {
          // Code and rich-render previews stay interactive/readable but never
          // open serializer-owned source without the explicit edit action.
          event.stopImmediatePropagation()
          return true
        }
        return false
      }

      event.preventDefault()
      event.stopImmediatePropagation()
      openEditor(parts, 'content')
      return true
    },
  })
}
