import { t } from './lang'
import {
  commitVditorWysiwygDomEdit,
  focusVditorRange,
  getVditorInternals,
  refreshVditorWysiwygCodePreview,
} from './vditor-adapter'
import { registerWysiwygDomFeature } from './wysiwyg-dom'
import {
  WYSIWYG_SOURCE_EDIT_BUTTON_CLASS,
  closeActiveWysiwygPopover,
  createWysiwygSourceEditButton,
  hideWysiwygSerializerSource,
  openWysiwygSourceEditSession,
} from './wysiwyg-popover'
import { deleteWysiwygBlocks } from './block-context-menu'

const ORDINARY_CLASS = 'vmd-code-block--ordinary'
const RICH_CLASS = 'vmd-code-block--rich'
const TOOLBAR_CLASS = 'vmd-code-toolbar'
const ACTIONS_CLASS = 'vmd-code-toolbar__actions'
const LANGUAGE_CLASS = 'vmd-code-language'
const ZERO_WIDTH_SPACE = '\u200b'
const SELECTED_CLASS = 'vmd-code-block--selected'
const BLOCK_EDGE_WIDTH = 18
const ATOMIC_BLOCK_SELECTOR = [
  '.vditor-wysiwyg__block[data-type="code-block"]',
  '.vditor-wysiwyg__block[data-type="math-block"]',
  '.vditor-wysiwyg__block[data-type="html-block"]',
].join(', ')
const INTERACTIVE_BLOCK_SELECTOR =
  'a, button, input, select, textarea, details, summary, audio, video, img, iframe, .vditor-copy, .vmd-code-toolbar, [contenteditable="true"]'

let selectedCodeBlock: HTMLElement | null = null

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

function isAtomicBlock(block: HTMLElement | null): block is HTMLElement {
  if (!block) return false
  const type = block.dataset.type
  if (type === 'code-block' || type === 'math-block') return true
  return (
    type === 'html-block' &&
    !block.classList.contains('vmd-details-opener') &&
    !block.classList.contains('vmd-details-closer')
  )
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

interface SourceLine {
  start: number
  end: number
  text: string
}

interface SourceRange {
  start: number
  end: number
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  while (start < source.length) {
    const newline = source.indexOf('\n', start)
    const end = newline < 0 ? source.length : newline
    lines.push({ start, end, text: source.slice(start, end) })
    if (newline < 0) break
    start = newline + 1
  }
  return lines
}

function stripQuotePrefixes(line: string): string {
  let value = line
  while (true) {
    const match = /^ {0,3}>[ \t]?/.exec(value)
    if (!match) return value
    value = value.slice(match[0].length)
  }
}

function openingFence(line: string): string | null {
  const match = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(stripQuotePrefixes(line))
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null
  return match[1]
}

function isClosingFence(line: string, opening: string): boolean {
  const value = stripQuotePrefixes(line).trim()
  return (
    value.length >= opening.length &&
    Array.from(value).every((character) => character === opening[0])
  )
}

function fencedCodeRanges(source: string): SourceRange[] {
  const lines = sourceLines(source)
  const ranges: SourceRange[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const opening = openingFence(lines[index].text)
    if (!opening) continue

    let closingIndex = index + 1
    while (
      closingIndex < lines.length &&
      !isClosingFence(lines[closingIndex].text, opening)
    ) {
      closingIndex += 1
    }
    const end = closingIndex < lines.length
      ? lines[closingIndex].end
      : source.length
    ranges.push({ start: lines[index].start, end })
    index = closingIndex
  }
  return ranges
}

function fallbackCodeBlockMarkdown(block: HTMLElement): string | null {
  const parts = getCodeBlockParts(block)
  if (!parts) return null
  const marker = block.dataset.marker || '```'
  const language = languageFromCode(parts.sourceCode)
  return `${marker}${language}\n${sourceText(parts.sourceCode)}\n${marker}`
}

function codeBlockMarkdown(block: HTMLElement): string | null {
  const root = block.closest<HTMLElement>('.vditor-reset')
  if (!root) return null
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>(
      '.vditor-wysiwyg__block[data-type="code-block"]'
    )
  )
  const index = blocks.indexOf(block)
  if (index < 0) return null

  const source = window.vditor?.getValue?.()
  if (typeof source === 'string') {
    const range = fencedCodeRanges(source)[index]
    if (range) return source.slice(range.start, range.end)
  }
  return fallbackCodeBlockMarkdown(block)
}

function sourceOwnedBlockMarkdown(block: HTMLElement): string | null {
  const preview = block.querySelector<HTMLElement>(
    ':scope > .vditor-wysiwyg__preview'
  )
  const source = preview?.previousElementSibling
  if (!(source instanceof HTMLElement)) return null
  const code = source.matches('code')
    ? source
    : source.querySelector<HTMLElement>(':scope > code')
  if (!code) return null

  let value = code.textContent || ''
  if (value.startsWith(ZERO_WIDTH_SPACE)) value = value.slice(1)
  if (block.dataset.type === 'html-block') return value
  if (block.dataset.type !== 'math-block') return null
  if (value.endsWith('\n')) value = value.slice(0, -1)
  const marker = block.dataset.marker || '$$'
  return `${marker}\n${value}\n${marker}`
}

function atomicBlockMarkdown(block: HTMLElement): string | null {
  return block.dataset.type === 'code-block'
    ? codeBlockMarkdown(block)
    : sourceOwnedBlockMarkdown(block)
}

function rangeSelectsNode(range: Range, node: HTMLElement): boolean {
  const parent = node.parentNode
  if (!parent || range.startContainer !== parent || range.endContainer !== parent) {
    return false
  }
  const index = Array.from(parent.childNodes).indexOf(node)
  return range.startOffset === index && range.endOffset === index + 1
}

function clearCodeBlockSelection(collapseAfter = false): void {
  const block = selectedCodeBlock
  selectedCodeBlock = null
  block?.classList.remove(SELECTED_CLASS)
  if (!collapseAfter || !block?.isConnected) return

  const range = document.createRange()
  range.selectNode(block)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function selectCodeBlock(block: HTMLElement): void {
  if (!block.isConnected) return
  if (selectedCodeBlock !== block) clearCodeBlockSelection()
  selectedCodeBlock = block
  block.classList.add(SELECTED_CLASS)
  block.closest<HTMLElement>('.vditor-reset')?.focus({ preventScroll: true })
  const range = document.createRange()
  range.selectNode(block)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function activeSelectedCodeBlock(): HTMLElement | null {
  const block = selectedCodeBlock
  const selection = window.getSelection()
  if (
    !block?.isConnected ||
    !selection ||
    selection.rangeCount !== 1 ||
    !rangeSelectsNode(selection.getRangeAt(0), block)
  ) {
    clearCodeBlockSelection()
    return null
  }
  return block
}

export function selectedCodeBlockClipboardText(): string | null {
  const block = activeSelectedCodeBlock()
  return block ? atomicBlockMarkdown(block) : null
}

export function cutSelectedCodeBlock(): boolean {
  const block = activeSelectedCodeBlock()
  if (!block) return false
  clearCodeBlockSelection()
  return deleteWysiwygBlocks([block])
}

function syncCopyTextarea(parts: CodeBlockParts): void {
  const textarea = parts.preview.querySelector<HTMLTextAreaElement>(
    `.${TOOLBAR_CLASS} .vditor-copy textarea`
  )
  if (textarea) textarea.value = sourceText(parts.sourceCode)
}

function closestElement(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement
}

function codeBlockAtRange(range: Range): HTMLElement | null {
  const start = closestElement(range.startContainer)?.closest<HTMLElement>(
    ATOMIC_BLOCK_SELECTOR
  ) || null
  const end = closestElement(range.endContainer)?.closest<HTMLElement>(
    ATOMIC_BLOCK_SELECTOR
  ) || null
  return start === end && isAtomicBlock(start) ? start : null
}

function rangeContainsNodeContents(range: Range, node: HTMLElement): boolean {
  const contents = document.createRange()
  contents.selectNodeContents(node)
  return (
    range.compareBoundaryPoints(Range.START_TO_START, contents) <= 0 &&
    range.compareBoundaryPoints(Range.END_TO_END, contents) >= 0
  )
}

function codeBlockBeforeBoundary(range: Range): HTMLElement | null {
  if (!range.collapsed || !(range.startContainer instanceof Element)) return null
  const previous = range.startContainer.childNodes[range.startOffset - 1]
  return previous instanceof HTMLElement && isAtomicBlock(previous)
    ? previous
    : null
}

function codeBlockAfterBoundary(range: Range): HTMLElement | null {
  if (!range.collapsed || !(range.startContainer instanceof Element)) return null
  const next = range.startContainer.childNodes[range.startOffset]
  return next instanceof HTMLElement && isAtomicBlock(next) ? next : null
}

function blockEdgePlacement(
  block: HTMLElement,
  target: Element,
  event: PointerEvent
): 'before' | 'after' | null {
  const interactive = target.closest(INTERACTIVE_BLOCK_SELECTOR)
  if (interactive && block.contains(interactive)) return null
  const rect = block.getBoundingClientRect()
  if (rect.width <= 0) return null
  const edgeWidth = Math.min(BLOCK_EDGE_WIDTH, rect.width / 4)
  if (event.clientX <= rect.left + edgeWidth) return 'before'
  if (event.clientX >= rect.right - edgeWidth) return 'after'
  return null
}

function placeCaretNextToBlock(
  block: HTMLElement,
  placement: 'before' | 'after'
): void {
  clearCodeBlockSelection()
  block.closest<HTMLElement>('.vditor-reset')?.focus({ preventScroll: true })
  const range = document.createRange()
  range.selectNode(block)
  range.collapse(placement === 'before')
  focusVditorRange(range)
}

function insertParagraphByCodeBlock(
  block: HTMLElement,
  placement: 'before' | 'after'
): boolean {
  const internal = getVditorInternals()
  if (
    !internal ||
    internal.currentMode !== 'wysiwyg' ||
    !block.isConnected ||
    !block.parentElement
  ) {
    return false
  }

  clearCodeBlockSelection()
  closeActiveWysiwygPopover()
  const paragraph = document.createElement('p')
  paragraph.dataset.block = '0'
  paragraph.innerHTML = '<br>'
  block.insertAdjacentElement(
    placement === 'before' ? 'beforebegin' : 'afterend',
    paragraph
  )

  const range = document.createRange()
  range.selectNodeContents(paragraph)
  range.collapse(true)
  focusVditorRange(range)
  commitVditorWysiwygDomEdit(internal)
  return true
}

/** Edits fenced blocks and coordinates shared atomic-block caret/selection behavior. */
export function initWysiwygCodeBlocks(): void {
  let writing = false
  let pendingSideClick: HTMLElement | null = null
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
    if (selectedCodeBlock && !root.contains(selectedCodeBlock)) {
      clearCodeBlockSelection()
    }
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
      placement: 'code',
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
    beforeRebind: () => {
      pendingSideClick = null
      clearCodeBlockSelection()
    },
    onPointerDown: (event) => {
      pendingSideClick = null
      const target = event.target instanceof Element ? event.target : null
      const editButton = target?.closest(
        `.${WYSIWYG_SOURCE_EDIT_BUTTON_CLASS}`
      )
      if (editButton) {
        event.preventDefault()
        event.stopImmediatePropagation()
        return true
      }

      const candidate = target?.closest<HTMLElement>(ATOMIC_BLOCK_SELECTOR) || null
      const block = isAtomicBlock(candidate) ? candidate : null
      const placement =
        event.button === 0 && block && target
          ? blockEdgePlacement(block, target, event)
          : null
      if (block && placement) {
        event.preventDefault()
        event.stopImmediatePropagation()
        pendingSideClick = block
        placeCaretNextToBlock(block, placement)
        return true
      }

      return false
    },
    onClick: (event) => {
      const target = event.target instanceof Element ? event.target : null
      if (
        target &&
        pendingSideClick &&
        (target === pendingSideClick || pendingSideClick.contains(target))
      ) {
        pendingSideClick = null
        event.preventDefault()
        event.stopImmediatePropagation()
        return true
      }
      pendingSideClick = null

      const atomicCandidate = target?.closest<HTMLElement>(
        ATOMIC_BLOCK_SELECTOR
      ) || null
      const atomicBlock = isAtomicBlock(atomicCandidate)
        ? atomicCandidate
        : null
      if (target && atomicBlock?.dataset.type === 'html-block') {
        const interactive = target.closest(INTERACTIVE_BLOCK_SELECTOR)
        const preview = atomicBlock.querySelector<HTMLElement>(
          ':scope > .vditor-wysiwyg__preview'
        )
        if (
          (!interactive || !atomicBlock.contains(interactive)) &&
          preview?.contains(target)
        ) {
          // Keep Chromium's native caret/text selection in rendered HTML, but
          // do not let Vditor move it into serializer-owned hidden source.
          event.stopImmediatePropagation()
          return true
        }
      }

      const block = atomicBlock?.dataset.type === 'code-block'
        ? atomicBlock
        : null
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
    onKeydown: (event) => {
      if (event.isComposing) return false
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(`.${TOOLBAR_CLASS}`)) return false

      const selection = window.getSelection()
      const range = selection?.rangeCount === 1
        ? selection.getRangeAt(0)
        : null
      const activeBlock = activeSelectedCodeBlock()
      const rangeBlock = range ? codeBlockAtRange(range) : null
      const beforeBlock = range ? codeBlockAfterBoundary(range) : null
      const afterBlock = range ? codeBlockBeforeBoundary(range) : null
      const block = activeBlock || rangeBlock

      if (event.key === 'Escape' && activeBlock) {
        event.preventDefault()
        event.stopImmediatePropagation()
        clearCodeBlockSelection(true)
        return true
      }

      if (event.key === 'Backspace' || event.key === 'Delete') {
        const destructiveBlock =
          block ||
          (event.key === 'Delete' ? beforeBlock : afterBlock)
        if (destructiveBlock) {
          event.preventDefault()
          event.stopImmediatePropagation()
          if (activeBlock) {
            clearCodeBlockSelection()
            deleteWysiwygBlocks([activeBlock])
          } else {
            selectCodeBlock(destructiveBlock)
          }
          return true
        }
      }

      if (
        event.key === 'Enter' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        const enterBlock = block || beforeBlock || afterBlock
        if (!enterBlock) return false
        event.preventDefault()
        event.stopImmediatePropagation()
        insertParagraphByCodeBlock(
          enterBlock,
          !block && beforeBlock ? 'before' : 'after'
        )
        return true
      }
      return false
    },
    onSelectionChange: () => {
      const selection = window.getSelection()
      const range = selection?.rangeCount === 1
        ? selection.getRangeAt(0)
        : null
      if (!range) {
        clearCodeBlockSelection()
        return false
      }
      if (selectedCodeBlock && rangeSelectsNode(range, selectedCodeBlock)) {
        return false
      }
      clearCodeBlockSelection()
      if (range.collapsed) return false

      const block = codeBlockAtRange(range)
      const parts = block ? getCodeBlockParts(block) : null
      const visibleCode = parts?.preview.querySelector<HTMLElement>(
        ':scope > code'
      )
      if (
        block?.classList.contains(ORDINARY_CLASS) &&
        visibleCode &&
        rangeContainsNodeContents(range, visibleCode)
      ) {
        selectCodeBlock(block)
      }
      return false
    },
    dispose: () => {
      pendingSideClick = null
      clearCodeBlockSelection()
    },
  })
}
