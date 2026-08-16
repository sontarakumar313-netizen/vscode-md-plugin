import { positionFloatingPanelAtPoint } from './floating-panel'
import { createMenuController } from './menu-controller'
import { t } from './lang'
import { commitVditorWysiwygHeadingEdit } from './vditor-adapter'
import { registerWysiwygDomFeature } from './wysiwyg-dom'

const MENU_ID = 'vmd-heading-level-menu'
const CURRENT_CLASS = 'vmd-heading-level-menu__current'
const HEADING_SELECTOR = 'h1[data-block="0"], h2[data-block="0"], h3[data-block="0"], h4[data-block="0"], h5[data-block="0"], h6[data-block="0"]'

interface MenuState {
  caretOffset: number
  heading: HTMLHeadingElement
  level: number
}

function headingLevel(heading: Element): number | null {
  const match = /^H([1-6])$/.exec(heading.tagName)
  return match ? Number(match[1]) : null
}

function caretOffsetInHeading(heading: HTMLHeadingElement): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return 0
  const range = selection.getRangeAt(0)
  if (!heading.contains(range.startContainer)) return 0

  const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT)
  let offset = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
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

/** Displays heading levels with Vditor's native pseudo labels. */
export function initWysiwygHeadingLevels(): void {
  const menu = createMenu()
  let root: HTMLElement | null = null
  let state: MenuState | null = null

  const hideMenu = (): void => {
    menuController.close()
    state = null
    menu.style.display = 'none'
    menu.style.visibility = ''
  }

  const refresh = (targetRoot: HTMLElement): void => {
    root = targetRoot
    if (state && (!state.heading.isConnected || !root.contains(state.heading))) {
      hideMenu()
    }
  }

  const applyLevel = (requestedLevel: number): void => {
    const current = state
    if (!current || requestedLevel < 1 || requestedLevel > 6) return
    const heading = current.heading
    if (!heading.isConnected) {
      hideMenu()
      return
    }

    if (requestedLevel === current.level) {
      hideMenu()
      root?.focus({ preventScroll: true })
      restoreCaretOffset(heading, current.caretOffset)
      return
    }

    const replacement = document.createElement(
      `h${requestedLevel}`
    ) as HTMLHeadingElement
    for (const attribute of Array.from(heading.attributes)) {
      replacement.setAttribute(attribute.name, attribute.value)
    }
    while (heading.firstChild) {
      replacement.appendChild(heading.firstChild)
    }
    heading.replaceWith(replacement)
    hideMenu()
    if (!commitVditorWysiwygHeadingEdit(window.vditor)) return

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

  const showMenu = (heading: HTMLHeadingElement, event: MouseEvent): void => {
    const level = headingLevel(heading)
    if (!level) return
    hideMenu()
    state = {
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
    menuController.open({
      safeTargets: [heading],
      onDismiss: hideMenu,
    })
    positionFloatingPanelAtPoint(menu, event.clientX, event.clientY)
  }

  const onContextMenu = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest(`#${MENU_ID}`)) return

    const heading = target?.closest<HTMLHeadingElement>(HEADING_SELECTOR)
    if (!heading || !root?.contains(heading)) {
      hideMenu()
      return
    }

    event.preventDefault()
    event.stopPropagation()
    showMenu(heading, event)
  }

  document.addEventListener('contextmenu', onContextMenu, true)

  registerWysiwygDomFeature({
    refresh,
    beforeRebind: hideMenu,
    dispose: () => {
      hideMenu()
      menuController.dispose()
      document.removeEventListener('contextmenu', onContextMenu, true)
      menu.remove()
      root = null
    },
  })
}
