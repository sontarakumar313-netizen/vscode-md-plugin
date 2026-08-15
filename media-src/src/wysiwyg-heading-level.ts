import { positionFloatingPanelAtTarget } from './floating-panel'
import { createMenuController } from './menu-controller'
import { t } from './lang'
import { commitVditorWysiwygHeadingEdit } from './vditor-adapter'
import { registerWysiwygDomFeature } from './wysiwyg-dom'

const BUTTON_CLASS = 'vmd-heading-level-button'
const DECORATED_CLASS = 'vmd-heading-level--decorated'
const MENU_ID = 'vmd-heading-level-menu'
const CURRENT_CLASS = 'vmd-heading-level-menu__current'
const HEADING_SELECTOR = 'h1[data-block="0"], h2[data-block="0"], h3[data-block="0"], h4[data-block="0"], h5[data-block="0"], h6[data-block="0"]'

interface MenuState {
  button: HTMLButtonElement
  caretOffset: number
  heading: HTMLHeadingElement
  level: number
}

function headingLevel(heading: Element): number | null {
  const match = /^H([1-6])$/.exec(heading.tagName)
  return match ? Number(match[1]) : null
}

function isControlText(node: Node): boolean {
  return !!node.parentElement?.closest(`.${BUTTON_CLASS}`)
}

function caretOffsetInHeading(heading: HTMLHeadingElement): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return 0
  const range = selection.getRangeAt(0)
  if (!heading.contains(range.startContainer)) return 0

  const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT)
  let offset = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (isControlText(node)) continue
    const text = node as Text
    if (text === range.startContainer) {
      return offset + Math.min(range.startOffset, text.length)
    }
    offset += text.length
  }
  return offset
}

function restoreCaretOffset(
  heading: HTMLHeadingElement,
  requestedOffset: number
): void {
  const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT)
  let remaining = Math.max(0, requestedOffset)
  let lastText: Text | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (isControlText(node)) continue
    const text = node as Text
    lastText = text
    if (remaining <= text.length) {
      const range = document.createRange()
      range.setStart(text, remaining)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }
    remaining -= text.length
  }

  const range = document.createRange()
  if (lastText) range.setStart(lastText, lastText.length)
  else range.selectNodeContents(heading)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function createMenu(): HTMLDivElement {
  const menu = document.createElement('div')
  menu.id = MENU_ID
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', t('changeHeadingLevel'))
  menu.style.display = 'none'
  for (let level = 1; level <= 6; level += 1) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.headingLevel = String(level)
    button.setAttribute('role', 'menuitemradio')
    button.textContent = `H${level}`
    menu.appendChild(button)
  }
  document.body.appendChild(menu)
  return menu
}

/** Adds an accessible H1-H6 menu to rendered WYSIWYG heading gutter labels. */
export function initWysiwygHeadingLevels(): void {
  const menu = createMenu()
  let root: HTMLElement | null = null
  let state: MenuState | null = null

  const hideMenu = (restoreFocus = false): void => {
    menuController.close()
    const previous = state
    state = null
    menu.style.display = 'none'
    menu.style.visibility = ''
    previous?.button.setAttribute('aria-expanded', 'false')
    if (restoreFocus && previous?.button.isConnected) {
      previous.button.focus({ preventScroll: true })
    }
  }

  const decorateHeading = (heading: HTMLHeadingElement): void => {
    const level = headingLevel(heading)
    if (!level) return
    heading.classList.add(DECORATED_CLASS)
    let button = heading.querySelector<HTMLButtonElement>(
      `:scope > .${BUTTON_CLASS}`
    )
    if (!button) {
      button = document.createElement('button')
      button.type = 'button'
      button.className = BUTTON_CLASS
      button.setAttribute('contenteditable', 'false')
      button.setAttribute('data-render', '1')
      button.setAttribute('aria-haspopup', 'menu')
      button.setAttribute('aria-expanded', 'false')
      heading.prepend(button)
    }
    const label = `H${level}`
    if (button.childNodes.length > 0) button.replaceChildren()
    button.dataset.label = label
    button.dataset.headingLevel = String(level)
    button.setAttribute('aria-label', `${t('changeHeadingLevel')}: H${level}`)
  }

  const refresh = (targetRoot: HTMLElement): void => {
    root = targetRoot
    targetRoot.querySelectorAll<HTMLHeadingElement>(HEADING_SELECTOR).forEach(
      decorateHeading
    )
    if (state && (!state.heading.isConnected || !state.button.isConnected)) {
      hideMenu()
    }
  }

  const showMenu = (
    heading: HTMLHeadingElement,
    button: HTMLButtonElement,
    focusCurrent = false
  ): void => {
    const level = headingLevel(heading)
    if (!level) return
    if (state?.button === button && menu.style.display === 'block') {
      hideMenu(true)
      return
    }
    hideMenu()
    state = {
      button,
      caretOffset: caretOffsetInHeading(heading),
      heading,
      level,
    }
    menu.querySelectorAll<HTMLButtonElement>('button[data-heading-level]')
      .forEach((item) => {
        const current = item.dataset.headingLevel === String(level)
        item.classList.toggle(CURRENT_CLASS, current)
        item.setAttribute('aria-checked', String(current))
      })
    button.setAttribute('aria-expanded', 'true')
    menuController.open({
      safeTargets: [button],
      onDismiss: (reason) => hideMenu(reason === 'escape'),
    })
    positionFloatingPanelAtTarget(menu, button)
    if (focusCurrent) {
      requestAnimationFrame(() => {
        menu.querySelector<HTMLButtonElement>(`.${CURRENT_CLASS}`)?.focus()
      })
    }
  }

  const applyLevel = (requestedLevel: number): void => {
    const current = state
    if (!current || requestedLevel < 1 || requestedLevel > 6) return
    if (requestedLevel === current.level) {
      hideMenu()
      root?.focus({ preventScroll: true })
      restoreCaretOffset(current.heading, current.caretOffset)
      return
    }
    if (!current.heading.isConnected) {
      hideMenu()
      return
    }

    const replacement = document.createElement(
      `h${requestedLevel}`
    ) as HTMLHeadingElement
    for (const attribute of Array.from(current.heading.attributes)) {
      replacement.setAttribute(attribute.name, attribute.value)
    }
    replacement.classList.remove(DECORATED_CLASS)
    for (const child of Array.from(current.heading.childNodes)) {
      if (child === current.button) continue
      replacement.appendChild(child)
    }
    current.heading.replaceWith(replacement)
    hideMenu()
    if (!commitVditorWysiwygHeadingEdit(window.vditor)) return
    decorateHeading(replacement)
    const restoreCaret = (): void => {
      if (!replacement.isConnected) return
      root?.focus({ preventScroll: true })
      restoreCaretOffset(replacement, current.caretOffset)
    }
    restoreCaret()
    window.setTimeout(restoreCaret, 0)
  }

  const menuController = createMenuController<HTMLButtonElement>({
    itemSelector: 'button[data-heading-level]',
    menu,
    onActivate: (button) => {
      const level = Number(button.dataset.headingLevel)
      if (Number.isInteger(level)) applyLevel(level)
    },
  })

  registerWysiwygDomFeature({
    refresh,
    beforeRebind: () => hideMenu(),
    onPointerDown: (event) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>(`.${BUTTON_CLASS}`)
        : null
      if (!target) return false
      event.preventDefault()
      event.stopImmediatePropagation()
      return true
    },
    onClick: (event) => {
      const button = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>(`.${BUTTON_CLASS}`)
        : null
      const heading = button?.closest<HTMLHeadingElement>(HEADING_SELECTOR)
      if (!button || !heading) return false
      event.preventDefault()
      event.stopImmediatePropagation()
      showMenu(heading, button)
      return true
    },
    onKeydown: (event) => {
      const button = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>(`.${BUTTON_CLASS}`)
        : null
      const heading = button?.closest<HTMLHeadingElement>(HEADING_SELECTOR)
      if (!button || !heading) return false
      if (
        event.key !== 'Enter' &&
        event.key !== ' ' &&
        event.key !== 'ArrowDown'
      ) {
        return false
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      showMenu(heading, button, true)
      return true
    },
    dispose: () => {
      hideMenu()
      menuController.dispose()
      menu.remove()
      root = null
    },
  })
}
