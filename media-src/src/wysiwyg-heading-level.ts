import { t } from './lang'
import { commitVditorWysiwygHeadingEdit } from './vditor-adapter'

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

function getWysiwygRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '.vditor-wysiwyg .vditor-reset'
  )
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

/** Adds an accessible H1-H6 menu to rendered WYSIWYG heading gutter labels. */
export function initWysiwygHeadingLevels(): {
  dispose(): void
  rebind(): void
} {
  const menu = createMenu()
  let root: HTMLElement | null = null
  let boundRoot: HTMLElement | null = null
  let observer: MutationObserver | null = null
  let refreshQueued = false
  let state: MenuState | null = null

  const hideMenu = (restoreFocus = false): void => {
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
    button.setAttribute(
      'aria-label',
      `${t('changeHeadingLevel')}: H${level}`
    )
  }

  const refresh = (): void => {
    refreshQueued = false
    root?.querySelectorAll<HTMLHeadingElement>(HEADING_SELECTOR).forEach(
      decorateHeading
    )
    if (state && (!state.heading.isConnected || !state.button.isConnected)) {
      hideMenu()
    }
  }

  const queueRefresh = (): void => {
    if (refreshQueued) return
    refreshQueued = true
    queueMicrotask(refresh)
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
    positionMenu(menu, button)
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
    // Restore immediately for hidden Webviews where animation frames can be
    // suspended, then once more after Vditor's synchronous click work settles.
    restoreCaret()
    window.setTimeout(restoreCaret, 0)
  }

  const onRootPointerDown = (event: PointerEvent): void => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>(`.${BUTTON_CLASS}`)
      : null
    if (!target) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  const onRootClick = (event: MouseEvent): void => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>(`.${BUTTON_CLASS}`)
      : null
    const heading = button?.closest<HTMLHeadingElement>(HEADING_SELECTOR)
    if (!button || !heading) return
    event.preventDefault()
    event.stopImmediatePropagation()
    showMenu(heading, button)
  }

  const onRootKeydown = (event: KeyboardEvent): void => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>(`.${BUTTON_CLASS}`)
      : null
    const heading = button?.closest<HTMLHeadingElement>(HEADING_SELECTOR)
    if (!button || !heading) return
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'ArrowDown') {
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    showMenu(heading, button, true)
  }

  const onMenuKeydown = (event: KeyboardEvent): void => {
    const buttons = Array.from(
      menu.querySelectorAll<HTMLButtonElement>('button[data-heading-level]')
    )
    const activeIndex = document.activeElement instanceof HTMLButtonElement
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
      hideMenu(true)
      return
    }
    if (nextIndex < 0) return
    event.preventDefault()
    event.stopPropagation()
    buttons[nextIndex]?.focus()
  }

  const onDocumentPointerDown = (event: PointerEvent): void => {
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest(`#${MENU_ID}, .${BUTTON_CLASS}`)) return
    hideMenu()
  }
  const onDocumentScroll = (): void => hideMenu()
  const onWindowResize = (): void => hideMenu()

  const unbindRoot = (): void => {
    observer?.disconnect()
    observer = null
    if (!boundRoot) return
    boundRoot.removeEventListener('pointerdown', onRootPointerDown, true)
    boundRoot.removeEventListener('click', onRootClick, true)
    boundRoot.removeEventListener('keydown', onRootKeydown, true)
    boundRoot = null
  }

  const rebind = (): void => {
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
    root.addEventListener('keydown', onRootKeydown, true)
    observer = new MutationObserver(queueRefresh)
    observer.observe(root, { childList: true, subtree: true })
    queueRefresh()
  }

  menu.addEventListener('pointerdown', (event) => event.preventDefault())
  menu.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('button[data-heading-level]')
      : null
    const level = Number(button?.dataset.headingLevel)
    if (Number.isInteger(level)) applyLevel(level)
  })
  menu.addEventListener('keydown', onMenuKeydown)
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('scroll', onDocumentScroll, true)
  window.addEventListener('resize', onWindowResize)

  rebind()
  return {
    dispose(): void {
      hideMenu()
      unbindRoot()
      document.removeEventListener('pointerdown', onDocumentPointerDown, true)
      document.removeEventListener('scroll', onDocumentScroll, true)
      window.removeEventListener('resize', onWindowResize)
      menu.remove()
      root = null
    },
    rebind,
  }
}
