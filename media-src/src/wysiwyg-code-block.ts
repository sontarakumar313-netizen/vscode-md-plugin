import { t } from './lang'
import {
  getVditorInternals,
  refreshVditorWysiwygCodePreview,
} from './vditor-adapter'
import { registerWysiwygDomFeature } from './wysiwyg-dom'
import {
  WYSIWYG_SOURCE_EDIT_BUTTON_CLASS,
  createWysiwygSourceEditButton,
  getSharedWysiwygPopover,
  hideWysiwygSerializerSource,
  openWysiwygSourceEditSession,
} from './wysiwyg-popover'
import { deleteWysiwygBlocks } from './block-context-menu'
import {
  WYSIWYG_ATOMIC_BLOCK_SELECTOR,
  WYSIWYG_ATOMIC_INTERACTIVE_SELECTOR,
  activeSelectedAtomicBlock,
  atomicBlockAfterBoundary,
  atomicBlockAtPoint,
  atomicBlockAtRange,
  atomicBlockBeforeBoundary,
  atomicBlockEdgePlacement,
  clearAtomicBlockSelection,
  getSelectedAtomicBlock,
  getWysiwygBlockParts,
  insertParagraphByAtomicBlock,
  isAtomicBlockGap,
  isWysiwygAtomicBlock,
  placeCaretNextToAtomicBlock,
  rangeContainsNodeContents,
  rangeSelectsAtomicBlock,
  selectAtomicBlock,
  sourceOwnedAtomicBlockMarkdown,
} from './wysiwyg-atomic-block'
import type { WysiwygBlockParts } from './wysiwyg-atomic-block'

const ORDINARY_CLASS = 'vmd-code-block--ordinary'
const RICH_CLASS = 'vmd-code-block--rich'
const TOOLBAR_CLASS = 'vmd-code-toolbar'
const ACTIONS_CLASS = 'vmd-code-toolbar__actions'
const LANGUAGE_CLASS = 'vmd-code-language'
const ZERO_WIDTH_SPACE = '\u200b'
const OVERLAY_EDITING_CLASS = 'vmd-code-block--overlay-editing'

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

type CodeBlockParts = WysiwygBlockParts

interface CodeSourceSelection {
  start: number
  end: number
}

interface KeyboardCodeEditRequest {
  allowDefault: boolean
}

function getCodeBlockParts(block: HTMLElement): CodeBlockParts | null {
  const parts = getWysiwygBlockParts(block)
  return parts?.kind === 'code-block' ? parts : null
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

function boundaryIsInside(container: HTMLElement, node: Node): boolean {
  return node === container || container.contains(node)
}

function textOffsetAtBoundary(
  container: HTMLElement,
  node: Node,
  offset: number
): number | null {
  const prefix = document.createRange()
  prefix.selectNodeContents(container)
  try {
    prefix.setEnd(node, offset)
  } catch (_) {
    return null
  }
  return prefix.toString().replaceAll(ZERO_WIDTH_SPACE, '').length
}

function codeSourceSelectionAt(
  parts: CodeBlockParts,
  range: Range
): CodeSourceSelection | null {
  const visibleCode = parts.preview.querySelector<HTMLElement>(':scope > code')
  if (
    !visibleCode ||
    !boundaryIsInside(visibleCode, range.startContainer) ||
    !boundaryIsInside(visibleCode, range.endContainer)
  ) {
    return null
  }

  const start = textOffsetAtBoundary(
    visibleCode,
    range.startContainer,
    range.startOffset
  )
  const end = textOffsetAtBoundary(
    visibleCode,
    range.endContainer,
    range.endOffset
  )
  if (start === null || end === null) return null
  const length = sourceText(parts.sourceCode).length
  return {
    start: Math.min(start, length),
    end: Math.min(end, length),
  }
}

function currentCodeSourceSelection(
  parts: CodeBlockParts
): CodeSourceSelection | null {
  const selection = window.getSelection()
  return selection?.rangeCount === 1
    ? codeSourceSelectionAt(parts, selection.getRangeAt(0))
    : null
}

function focusCodeSourceSelection(
  control: HTMLTextAreaElement,
  selection: CodeSourceSelection
): void {
  const length = control.value.length
  control.focus({ preventScroll: true })
  control.setSelectionRange(
    Math.min(selection.start, length),
    Math.min(selection.end, length)
  )
}

function keyboardCodeEditRequest(
  event: KeyboardEvent
): KeyboardCodeEditRequest | null {
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    event.key === 'Process' ||
    event.key === 'Dead'
  ) {
    return { allowDefault: true }
  }

  if (event.key === 'Backspace' || event.key === 'Delete') {
    return { allowDefault: false }
  }
  const altGraph = event.getModifierState('AltGraph')
  const hasCommandModifier =
    event.metaKey ||
    (event.ctrlKey && !altGraph) ||
    (event.altKey && !altGraph)
  if (hasCommandModifier) return null
  if (event.key === 'Enter') return { allowDefault: false }
  if (event.key === 'Tab' && !event.shiftKey) return { allowDefault: false }
  return event.key.length === 1 ? { allowDefault: false } : null
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

function atomicBlockMarkdown(block: HTMLElement): string | null {
  return block.dataset.type === 'code-block'
    ? codeBlockMarkdown(block)
    : sourceOwnedAtomicBlockMarkdown(block)
}

export function selectedCodeBlockClipboardText(): string | null {
  const block = activeSelectedAtomicBlock()
  return block ? atomicBlockMarkdown(block) : null
}

export function cutSelectedCodeBlock(): boolean {
  const block = activeSelectedAtomicBlock()
  if (!block) return false
  clearAtomicBlockSelection()
  return deleteWysiwygBlocks([block])
}

function syncCopyTextarea(parts: CodeBlockParts): void {
  const textarea = parts.preview.querySelector<HTMLTextAreaElement>(
    `.${TOOLBAR_CLASS} .vditor-copy textarea`
  )
  if (textarea) textarea.value = sourceText(parts.sourceCode)
}

/** Edits fenced blocks and coordinates shared atomic-block caret/selection behavior. */
export function initWysiwygCodeBlocks(): void {
  let writing = false
  let pendingSideClick: HTMLElement | null = null
  let suppressNextAtomicClick = false
  const guardedPreviews = new Set<HTMLElement>()
  const renderTimers = new WeakMap<HTMLElement, number>()
  const renderVersions = new WeakMap<HTMLElement, number>()

  const stopVditorPreviewEvent = (event: Event): void => {
    // Target handlers and browser defaults have already run by the time a
    // bubbling event reaches the preview. Stop only the editor-root listener
    // that would reveal serializer-owned source through Vditor's showCode().
    event.stopPropagation()
  }

  function clearPreviewGuards(): void {
    guardedPreviews.forEach((preview) => {
      preview.removeEventListener('click', stopVditorPreviewEvent)
      preview.removeEventListener('keyup', stopVditorPreviewEvent)
    })
    guardedPreviews.clear()
  }

  function guardAtomicPreviews(root: HTMLElement): void {
    guardedPreviews.forEach((preview) => {
      if (preview.isConnected && root.contains(preview)) return
      preview.removeEventListener('click', stopVditorPreviewEvent)
      preview.removeEventListener('keyup', stopVditorPreviewEvent)
      guardedPreviews.delete(preview)
    })
    root
      .querySelectorAll<HTMLElement>(WYSIWYG_ATOMIC_BLOCK_SELECTOR)
      .forEach((block) => {
        const preview = block.querySelector<HTMLElement>(
          ':scope > .vditor-wysiwyg__preview'
        )
        if (!preview || guardedPreviews.has(preview)) return
        preview.addEventListener('click', stopVditorPreviewEvent)
        preview.addEventListener('keyup', stopVditorPreviewEvent)
        guardedPreviews.add(preview)
      })
  }

  function decorateBlock(block: HTMLElement): void {
    const parts = getCodeBlockParts(block)
    if (!parts) return
    const language = languageFromCode(parts.sourceCode)
    const rich =
      !block.classList.contains(OVERLAY_EDITING_CLASS) &&
      isSpecialLanguage(language)
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
    guardAtomicPreviews(root)
    const selectedBlock = getSelectedAtomicBlock()
    if (selectedBlock && !root.contains(selectedBlock)) {
      clearAtomicBlockSelection()
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
    focusField: 'language' | 'content',
    requestedSelection?: CodeSourceSelection
  ): void {
    const internal = getVditorInternals()
    if (!internal || internal.currentMode !== 'wysiwyg') return
    const overlay = parts.block.classList.contains(ORDINARY_CLASS)
    const sourceSelection = requestedSelection ??
      currentCodeSourceSelection(parts)
    const initialLanguage = languageFromCode(parts.sourceCode)
    const initialContent = sourceText(parts.sourceCode)
    if (overlay) parts.block.classList.add(OVERLAY_EDITING_CLASS)

    const opened = openWysiwygSourceEditSession({
      target: parts.block,
      focusField,
      placement: overlay ? 'code-overlay' : 'code',
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
          acceptsTab: overlay,
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
        if (!overlay) {
          schedulePreviewRender(parts, () => {
            refreshVditorWysiwygCodePreview(
              internal,
              parts.source,
              parts.preview
            )
            hideWysiwygSerializerSource(parts.source)
            registration.requestRefresh()
          })
        }
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
      afterFinish: () => {
        if (!overlay) return
        parts.block.classList.remove(OVERLAY_EDITING_CLASS)
        registration.requestRefresh()
      },
    })
    if (!opened) {
      parts.block.classList.remove(OVERLAY_EDITING_CLASS)
      return
    }
    if (!overlay || focusField !== 'content' || !sourceSelection) return
    const contentControl = getSharedWysiwygPopover()
      ?.querySelector<HTMLTextAreaElement>('textarea[name="content"]')
    if (contentControl) {
      focusCodeSourceSelection(contentControl, sourceSelection)
    }
  }

  const registration = registerWysiwygDomFeature({
    refresh,
    beforeRebind: () => {
      pendingSideClick = null
      suppressNextAtomicClick = false
      clearPreviewGuards()
      clearAtomicBlockSelection()
    },
    onPointerDown: (event) => {
      pendingSideClick = null
      suppressNextAtomicClick = false
      const target = event.target instanceof Element ? event.target : null
      const editButton = target?.closest(
        `.${WYSIWYG_SOURCE_EDIT_BUTTON_CLASS}`
      )
      if (editButton) {
        event.preventDefault()
        event.stopImmediatePropagation()
        return true
      }

      const candidate = target?.closest<HTMLElement>(
        WYSIWYG_ATOMIC_BLOCK_SELECTOR
      ) || null
      const block = isWysiwygAtomicBlock(candidate) ? candidate : null
      const placement =
        event.button === 0 && block && target
          ? atomicBlockEdgePlacement(block, target, event)
          : null
      if (block && placement) {
        event.preventDefault()
        event.stopImmediatePropagation()
        pendingSideClick = block
        placeCaretNextToAtomicBlock(block, placement)
        return true
      }

      const projectedBlock = block || atomicBlockAtPoint(event)
      if (
        event.button === 0 &&
        projectedBlock &&
        target &&
        isAtomicBlockGap(projectedBlock, target, event)
      ) {
        // Margins and wrapper-only whitespace are not editing surfaces. Claim
        // pointerdown before Chromium briefly projects the caret into the
        // nearest preview, and suppress the matching click before Vditor can
        // transfer that caret into hidden source.
        event.preventDefault()
        event.stopImmediatePropagation()
        suppressNextAtomicClick = true
        return true
      }

      return false
    },
    onClick: (event) => {
      const target = event.target instanceof Element ? event.target : null
      if (suppressNextAtomicClick) {
        suppressNextAtomicClick = false
        event.preventDefault()
        event.stopImmediatePropagation()
        return true
      }
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
        WYSIWYG_ATOMIC_BLOCK_SELECTOR
      ) || null
      const atomicBlock = isWysiwygAtomicBlock(atomicCandidate)
        ? atomicCandidate
        : null
      const codeBlock = atomicBlock?.dataset.type === 'code-block'
        ? atomicBlock
        : null
      const parts = codeBlock ? getCodeBlockParts(codeBlock) : null
      if (target && parts) {
        if (target.closest('.vditor-copy')) return false
        const editButton = target.closest(
          `.${WYSIWYG_SOURCE_EDIT_BUTTON_CLASS}`
        )
        if (editButton) {
          event.preventDefault()
          event.stopImmediatePropagation()
          openEditor(parts, 'content')
          return true
        }
      }

      if (target && atomicBlock) {
        const preview = atomicBlock.querySelector<HTMLElement>(
          ':scope > .vditor-wysiwyg__preview'
        )
        if (preview?.contains(target)) {
          const interactive = target.closest(
            WYSIWYG_ATOMIC_INTERACTIVE_SELECTOR
          )
          if (interactive && atomicBlock.contains(interactive)) {
            // A preview-level bubbling guard preserves the target's own click
            // and default action, then stops Vditor at the editor root.
            return false
          }
          // Rendered block content remains selectable/readable, but ordinary
          // clicks never reveal source or open an editor.
          event.stopImmediatePropagation()
          return true
        }
      }

      return false
    },
    onKeydown: (event) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(`.${TOOLBAR_CLASS}`)) return false

      const selection = window.getSelection()
      const range = selection?.rangeCount === 1
        ? selection.getRangeAt(0)
        : null
      const rangeBlock = range ? atomicBlockAtRange(range) : null
      const rangeParts = rangeBlock ? getCodeBlockParts(rangeBlock) : null
      const sourceSelection =
        rangeParts && rangeBlock?.classList.contains(ORDINARY_CLASS) && range
          ? codeSourceSelectionAt(rangeParts, range)
          : null
      const editRequest = sourceSelection
        ? keyboardCodeEditRequest(event)
        : null
      if (rangeParts && sourceSelection && editRequest) {
        if (!editRequest.allowDefault) event.preventDefault()
        event.stopImmediatePropagation()
        openEditor(rangeParts, 'content', sourceSelection)
        return true
      }
      if (event.isComposing) return false

      const activeBlock = activeSelectedAtomicBlock()
      const beforeBlock = range ? atomicBlockAfterBoundary(range) : null
      const afterBlock = range ? atomicBlockBeforeBoundary(range) : null
      const block = activeBlock || rangeBlock

      if (event.key === 'Escape' && activeBlock) {
        event.preventDefault()
        event.stopImmediatePropagation()
        clearAtomicBlockSelection(true)
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
            clearAtomicBlockSelection()
            deleteWysiwygBlocks([activeBlock])
          } else {
            selectAtomicBlock(destructiveBlock)
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
        insertParagraphByAtomicBlock(
          enterBlock,
          !block && beforeBlock ? 'before' : 'after'
        )
        return true
      }
      return false
    },
    onKeyup: (event) => {
      if (
        event.key !== 'ArrowDown' &&
        event.key !== 'ArrowRight' &&
        event.key !== 'ArrowLeft' &&
        event.key !== 'ArrowUp' &&
        event.key !== 'Backspace'
      ) {
        return false
      }
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(WYSIWYG_ATOMIC_BLOCK_SELECTOR)) {
        // Preview-level bubbling guards run after target handlers.
        return false
      }
      const selection = window.getSelection()
      const range = selection?.rangeCount === 1
        ? selection.getRangeAt(0)
        : null
      if (!range || !atomicBlockAtRange(range)) return false
      event.stopImmediatePropagation()
      return true
    },
    onSelectionChange: () => {
      const selection = window.getSelection()
      const range = selection?.rangeCount === 1
        ? selection.getRangeAt(0)
        : null
      if (!range) {
        clearAtomicBlockSelection()
        return false
      }
      const selectedBlock = getSelectedAtomicBlock()
      if (selectedBlock && rangeSelectsAtomicBlock(range, selectedBlock)) {
        return false
      }
      clearAtomicBlockSelection()
      if (range.collapsed) return false

      const block = atomicBlockAtRange(range)
      const parts = block ? getCodeBlockParts(block) : null
      const visibleCode = parts?.preview.querySelector<HTMLElement>(
        ':scope > code'
      )
      if (
        block?.classList.contains(ORDINARY_CLASS) &&
        visibleCode &&
        rangeContainsNodeContents(range, visibleCode)
      ) {
        selectAtomicBlock(block)
      }
      return false
    },
    dispose: () => {
      pendingSideClick = null
      suppressNextAtomicClick = false
      clearPreviewGuards()
      clearAtomicBlockSelection()
    },
  })
}
