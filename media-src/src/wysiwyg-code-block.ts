import { t } from './lang'
import {
  commitVditorWysiwygDomEdit,
  getVditorInternals,
  refreshVditorWysiwygCodePreview,
} from './vditor-adapter'

const ORDINARY_CLASS = 'vmd-code-block--ordinary'
const TOOLBAR_CLASS = 'vmd-code-toolbar'
const LANGUAGE_BUTTON_CLASS = 'vmd-code-language-button'
const MENU_ID = 'vmd-code-language-menu'
const MENU_CURRENT_CLASS = 'vmd-code-language-menu__current'
const ZERO_WIDTH_SPACE = '\u200b'

const COMMON_LANGUAGES = [
  'javascript',
  'typescript',
  'python',
  'java',
  'c',
  'cpp',
  'csharp',
  'go',
  'rust',
  'html',
  'css',
  'json',
  'yaml',
  'bash',
  'shell',
  'sql',
  'xml',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'r',
  'scala',
  'diff',
  'dockerfile',
  'makefile',
  'toml',
  'ini',
  'markdown',
] as const
const COMMON_LANGUAGE_SET = new Set<string>(COMMON_LANGUAGES)

/** Languages rendered as diagrams or other rich previews remain native Vditor blocks. */
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
  previewPre: HTMLElement
  previewCode: HTMLElement
}

interface LanguageMenuState extends CodeBlockParts {
  button: HTMLButtonElement
  language: string
  languages: ReadonlySet<string>
  caretOffset: number | null
}

function getWysiwygRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '.vditor-wysiwyg .vditor-reset'
  )
}

function getCodeBlockParts(block: HTMLElement): CodeBlockParts | null {
  if (block.getAttribute('data-type') !== 'code-block') return null
  const source = block.querySelector<HTMLElement>(
    ':scope > .vditor-wysiwyg__pre'
  )
  const sourceCode = source?.querySelector<HTMLElement>(':scope > code') ?? null
  const preview = block.querySelector<HTMLElement>(
    ':scope > .vditor-wysiwyg__preview'
  )
  const previewPre = preview?.matches('pre')
    ? preview
    : preview?.querySelector<HTMLElement>(':scope > pre') ?? null
  const previewCode = previewPre?.querySelector<HTMLElement>(':scope > code') ?? null
  return source && sourceCode && preview && previewPre && previewCode
    ? { block, source, sourceCode, preview, previewPre, previewCode }
    : null
}

function languageFromCode(code: HTMLElement): string {
  const match = /(?:^|\s)language-([^\s]+)/.exec(code.className)
  return match?.[1] || ''
}

function languageLabel(language: string): string {
  return language || t('plainTextCode')
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

function syncCopyTextarea(parts: CodeBlockParts): void {
  const textarea = parts.previewPre.querySelector<HTMLTextAreaElement>(
    `:scope > .${TOOLBAR_CLASS} .vditor-copy textarea`
  )
  if (textarea) textarea.value = sourceText(parts.sourceCode)
}

function selectionOffsetWithin(element: HTMLElement): number | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const active = selection.getRangeAt(0)
  if (!element.contains(active.startContainer)) return null
  const range = document.createRange()
  range.selectNodeContents(element)
  try {
    range.setEnd(active.startContainer, active.startOffset)
  } catch (_) {
    return null
  }
  return range.toString().length
}

function restoreTextOffset(element: HTMLElement, requestedOffset: number): void {
  const offset = Math.max(0, requestedOffset)
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let remaining = offset
  let text = walker.nextNode()
  while (text) {
    const length = text.textContent?.length ?? 0
    if (remaining <= length) {
      const range = document.createRange()
      range.setStart(text, remaining)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }
    remaining -= length
    text = walker.nextNode()
  }

  const fallback = document.createRange()
  fallback.selectNodeContents(element)
  fallback.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(fallback)
}

function positionMenu(menu: HTMLElement, target: HTMLElement): void {
  const margin = 8
  const gap = 4
  menu.style.display = 'block'
  menu.style.visibility = 'hidden'
  menu.style.left = '0'
  menu.style.top = '0'

  const targetRect = target.getBoundingClientRect()
  const maxLeft = Math.max(margin, window.innerWidth - menu.offsetWidth - margin)
  const left = Math.min(Math.max(targetRect.left, margin), maxLeft)
  const below = targetRect.bottom + gap
  const above = targetRect.top - menu.offsetHeight - gap
  const maxTop = Math.max(margin, window.innerHeight - menu.offsetHeight - margin)
  const top = below <= maxTop || above < margin ? Math.min(below, maxTop) : above

  menu.style.left = `${left}px`
  menu.style.top = `${Math.max(margin, top)}px`
  menu.style.visibility = 'visible'
}

function createLanguageMenu(): HTMLDivElement {
  const menu = document.createElement('div')
  menu.id = MENU_ID
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', t('changeCodeLanguage'))
  document.body.appendChild(menu)
  return menu
}

/**
 * Adds a persistent language/copy toolbar to ordinary WYSIWYG code blocks.
 * Source editing remains Vditor-native: clicking the rendered code opens its
 * editable source above the still-visible preview.
 */
export function initWysiwygCodeBlocks(): { rebind(): void } {
  const menu = createLanguageMenu()
  let state: LanguageMenuState | null = null
  let root: HTMLElement | null = null
  let boundRoot: HTMLElement | null = null
  let observer: MutationObserver | null = null
  let refreshQueued = false

  function hideMenu(): void {
    state?.button.setAttribute('aria-expanded', 'false')
    state = null
    menu.style.display = 'none'
    menu.style.visibility = ''
  }

  function menuLanguages(current: string): string[] {
    const languages = ['']
    if (current && !COMMON_LANGUAGE_SET.has(current)) {
      languages.push(current)
    }
    languages.push(...COMMON_LANGUAGES)
    return languages
  }

  function buildMenu(current: string): ReadonlySet<string> {
    const languages = menuLanguages(current)
    menu.replaceChildren()
    for (const language of languages) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.codeLanguage = language
      button.setAttribute('role', 'menuitemradio')
      button.setAttribute('aria-checked', String(language === current))
      button.classList.toggle(MENU_CURRENT_CLASS, language === current)
      button.textContent = languageLabel(language)
      menu.appendChild(button)
    }
    return new Set(languages)
  }

  function showMenu(button: HTMLButtonElement, focusCurrent = false): void {
    const block = button.closest<HTMLElement>(
      `.vditor-wysiwyg__block.${ORDINARY_CLASS}`
    )
    const parts = block ? getCodeBlockParts(block) : null
    if (!parts) return
    if (state?.button === button && menu.style.display === 'block') {
      hideMenu()
      return
    }

    hideMenu()
    const language = languageFromCode(parts.sourceCode)
    const languages = buildMenu(language)
    state = {
      ...parts,
      button,
      language,
      languages,
      caretOffset: selectionOffsetWithin(parts.sourceCode),
    }
    button.setAttribute('aria-expanded', 'true')
    positionMenu(menu, button)
    if (focusCurrent) {
      requestAnimationFrame(() => {
        menu
          .querySelector<HTMLButtonElement>(`.${MENU_CURRENT_CLASS}`)
          ?.focus()
      })
    }
  }

  function decorateBlock(block: HTMLElement): void {
    const parts = getCodeBlockParts(block)
    if (!parts) return
    const language = languageFromCode(parts.sourceCode)
    if (isSpecialLanguage(language)) {
      block.classList.remove(ORDINARY_CLASS)
      parts.previewPre.querySelector(`:scope > .${TOOLBAR_CLASS}`)?.remove()
      return
    }

    block.classList.add(ORDINARY_CLASS)

    let toolbar = parts.previewPre.querySelector<HTMLElement>(
      `:scope > .${TOOLBAR_CLASS}`
    )
    let languageButton = toolbar?.querySelector<HTMLButtonElement>(
      `:scope > .${LANGUAGE_BUTTON_CLASS}`
    ) ?? null
    if (!toolbar) {
      toolbar = document.createElement('div')
      toolbar.className = TOOLBAR_CLASS
      toolbar.setAttribute('contenteditable', 'false')
      toolbar.setAttribute('data-render', '1')
      parts.previewPre.insertBefore(toolbar, parts.previewPre.firstChild)
    }
    if (!languageButton) {
      languageButton = document.createElement('button')
      languageButton.type = 'button'
      languageButton.className = LANGUAGE_BUTTON_CLASS
      languageButton.setAttribute('contenteditable', 'false')
      languageButton.setAttribute('aria-haspopup', 'menu')
      languageButton.setAttribute('aria-expanded', 'false')
      toolbar.appendChild(languageButton)
    }

    const label = languageLabel(language)
    if (languageButton.textContent !== label) languageButton.textContent = label
    languageButton.dataset.codeLanguage = language
    languageButton.setAttribute(
      'aria-label',
      `${t('changeCodeLanguage')}: ${label}`
    )

    const copy = parts.previewPre.querySelector<HTMLElement>(
      ':scope > .vditor-copy'
    )
    if (copy && copy.parentElement !== toolbar) toolbar.appendChild(copy)
    syncCopyTextarea(parts)
  }

  function refresh(): void {
    refreshQueued = false
    const activeRoot = root
    if (!activeRoot) return
    activeRoot
      .querySelectorAll<HTMLElement>(
        '.vditor-wysiwyg__block[data-type="code-block"]'
      )
      .forEach(decorateBlock)

    if (state && (!state.button.isConnected || !state.block.isConnected)) {
      hideMenu()
    }
  }

  function queueRefresh(): void {
    if (refreshQueued) return
    refreshQueued = true
    queueMicrotask(refresh)
  }

  function ordinaryBlockFor(target: Element | null): HTMLElement | null {
    return target?.closest<HTMLElement>(
      `.vditor-wysiwyg__block.${ORDINARY_CLASS}`
    ) ?? null
  }

  function onRootPointerDown(event: PointerEvent): void {
    const target = event.target instanceof Element ? event.target : null
    const block = ordinaryBlockFor(target)
    if (!target || !block || !target.closest(`.${TOOLBAR_CLASS}`)) return
    const parts = getCodeBlockParts(block)
    if (!parts) return

    // Toolbar actions must not move the source caret or make Vditor interpret
    // the control press as a request to open the source panel.
    syncCopyTextarea(parts)
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function onRootClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null
    if (!ordinaryBlockFor(target)) return

    const languageButton = target?.closest<HTMLButtonElement>(
      `.${LANGUAGE_BUTTON_CLASS}`
    )
    if (languageButton) {
      event.preventDefault()
      event.stopImmediatePropagation()
      showMenu(languageButton)
      return
    }
    if (target?.closest(`.${TOOLBAR_CLASS}`)) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    // Code-body clicks intentionally continue to Vditor's native WYSIWYG
    // handler, which opens the editable source above the rendered preview.
  }

  function applyLanguage(language: string): void {
    const current = state
    if (!current || !current.languages.has(language)) return
    const restoreOffset =
      selectionOffsetWithin(current.sourceCode) ?? current.caretOffset
    const sourceWasOpen = getComputedStyle(current.source).display !== 'none'
    hideMenu()
    if (language === current.language) {
      if (sourceWasOpen && restoreOffset !== null) {
        restoreTextOffset(current.sourceCode, restoreOffset)
      }
      return
    }

    const internal = getVditorInternals()
    if (
      !internal ||
      internal.currentMode !== 'wysiwyg' ||
      !current.block.isConnected ||
      !current.sourceCode.isConnected
    ) {
      return
    }

    setSourceLanguage(current.sourceCode, language)
    internal.hint.recentLanguage = language
    refreshVditorWysiwygCodePreview(
      internal,
      current.source,
      current.preview
    )
    if (sourceWasOpen) current.source.style.display = 'block'
    decorateBlock(current.block)
    commitVditorWysiwygDomEdit(internal)

    requestAnimationFrame(() => {
      const nextParts = getCodeBlockParts(current.block)
      if (!nextParts) return
      if (sourceWasOpen) {
        nextParts.source.style.display = 'block'
        if (restoreOffset !== null) {
          restoreTextOffset(nextParts.sourceCode, restoreOffset)
        }
      } else {
        nextParts.previewPre
          .querySelector<HTMLButtonElement>(`.${LANGUAGE_BUTTON_CLASS}`)
          ?.focus({ preventScroll: true })
      }
    })
  }

  function onDocumentPointerDown(event: PointerEvent): void {
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest(`#${MENU_ID}`)) return

    const codeButton = target?.closest(`.${LANGUAGE_BUTTON_CLASS}`) ?? null
    if (!codeButton) hideMenu()
  }

  function sourcePartsFromSelection(): CodeBlockParts | null {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return null
    const node = selection.getRangeAt(0).startContainer
    const element = node instanceof Element ? node : node.parentElement
    const block = ordinaryBlockFor(element)
    if (!block) return null
    const parts = getCodeBlockParts(block)
    return parts?.source.contains(node) ? parts : null
  }

  function onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && menu.style.display === 'block') {
      event.preventDefault()
      event.stopImmediatePropagation()
      hideMenu()
      return
    }
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest(`#${MENU_ID}`)) return

    const parts = sourcePartsFromSelection()
    if (
      !parts ||
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.key !== 'Enter'
    ) {
      return
    }
    const button = parts.previewPre.querySelector<HTMLButtonElement>(
      `.${LANGUAGE_BUTTON_CLASS}`
    )
    if (!button) return
    event.preventDefault()
    event.stopImmediatePropagation()
    showMenu(button, true)
  }

  function onMenuKeydown(event: KeyboardEvent): void {
    const buttons = Array.from(
      menu.querySelectorAll<HTMLButtonElement>('button[data-code-language]')
    )
    const activeIndex =
      document.activeElement instanceof HTMLButtonElement
        ? buttons.indexOf(document.activeElement)
        : -1
    let nextIndex = -1
    if (event.key === 'ArrowDown') {
      nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % buttons.length
    } else if (event.key === 'ArrowUp') {
      nextIndex = activeIndex <= 0 ? buttons.length - 1 : activeIndex - 1
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = buttons.length - 1
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      hideMenu()
      return
    }
    if (nextIndex < 0) return
    event.preventDefault()
    event.stopPropagation()
    buttons[nextIndex]?.focus()
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
    hideMenu()
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

  menu.addEventListener('pointerdown', (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target?.closest('button[data-code-language]')) return
    // Keep the source caret only when a language item is pressed. Preventing
    // pointerdown on the whole menu also prevents dragging its native scrollbar.
    event.preventDefault()
    event.stopPropagation()
  })
  menu.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest<HTMLButtonElement>(
      'button[data-code-language]'
    )
    const language = button?.dataset.codeLanguage
    if (language !== undefined) applyLanguage(language)
  })
  menu.addEventListener('keydown', onMenuKeydown)
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('keydown', onDocumentKeydown, true)
  document.addEventListener(
    'scroll',
    (event) => {
      // The menu is intentionally scrollable. Scroll events do not bubble but
      // are observable here in capture phase, so ignore the menu's own scroll
      // while still closing it when an editor or outer container moves.
      if (
        event.target === menu ||
        (event.target instanceof Node && menu.contains(event.target))
      ) {
        return
      }
      hideMenu()
    },
    true
  )
  window.addEventListener('resize', hideMenu)
  window.addEventListener('blur', hideMenu)

  rebind()
  return { rebind }
}
