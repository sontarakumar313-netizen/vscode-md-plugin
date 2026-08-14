import {
  activateFloatingPanel,
  deactivateFloatingPanel,
  positionFloatingPanelAtPoint,
} from './floating-panel'
import {
  commitVditorWysiwygDomEdit,
  focusVditorRange,
  getVditorInternals,
} from './vditor-adapter'
import { t } from './lang'
import { getWysiwygRoot } from './wysiwyg-dom'
import { findInnermostDetailsBlocks } from './wysiwyg-details'
import { closeActiveWysiwygPopover } from './wysiwyg-popover'

const MENU_ID = 'vmd-block-context-menu'
const DIRECT_BLOCK_SELECTOR = [
  'blockquote',
  '.vditor-wysiwyg__block[data-type="code-block"]',
  '.vditor-wysiwyg__block[data-type="math-block"]',
].join(', ')

type DeletableBlockKind =
  | 'quote'
  | 'alert'
  | 'details'
  | 'code-block'
  | 'math-block'

interface DeletableBlock {
  kind: DeletableBlockKind
  blocks: HTMLElement[]
}

interface FocusTarget {
  element: HTMLElement
  atStart: boolean
}

let hideContextMenu: (() => void) | null = null

function icon(name: string): string {
  return `<svg aria-hidden="true"><use xlink:href="#vditor-icon-${name}"></use></svg>`
}

function labelFor(kind: DeletableBlockKind): string {
  switch (kind) {
    case 'quote':
      return t('deleteQuote')
    case 'alert':
      return t('deleteAlert')
    case 'details':
      return t('deleteDetails')
    case 'code-block':
      return t('deleteCodeBlock')
    case 'math-block':
      return t('deleteMathBlock')
  }
}

function createMenu(): HTMLDivElement {
  const menu = document.createElement('div')
  menu.id = MENU_ID
  menu.setAttribute('role', 'menu')

  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('role', 'menuitem')
  button.dataset.type = 'delete-block'
  button.className = 'vmd-table-context-menu__danger'

  const iconElement = document.createElement('span')
  iconElement.className = 'vmd-table-context-menu__icon'
  iconElement.innerHTML = icon('trashcan')

  const label = document.createElement('span')
  label.className = 'vmd-table-context-menu__label'
  button.append(iconElement, label)
  menu.appendChild(button)
  document.body.appendChild(menu)
  return menu
}

function directBlockKind(block: HTMLElement): DeletableBlockKind | null {
  if (block.tagName === 'BLOCKQUOTE') {
    return block.classList.contains('vmd-alert') ||
      block.hasAttribute('data-vmd-alert')
      ? 'alert'
      : 'quote'
  }

  const type = block.dataset.type
  if (type === 'code-block' || type === 'math-block') return type
  return null
}

function resolveDeletableBlock(target: Element): DeletableBlock | null {
  const root = getWysiwygRoot()
  if (!root || !root.contains(target)) return null

  // A directly hit nested region wins over a containing details group. For
  // example, right-clicking a quote inside an expanded details block deletes
  // the quote, while right-clicking ordinary details content deletes details.
  const direct = target.closest<HTMLElement>(DIRECT_BLOCK_SELECTOR)
  if (direct && root.contains(direct)) {
    const kind = directBlockKind(direct)
    if (kind) return { kind, blocks: [direct] }
  }

  const detailsBlocks = findInnermostDetailsBlocks(root, target)
  return detailsBlocks && detailsBlocks.length > 0
    ? { kind: 'details', blocks: detailsBlocks }
    : null
}

function canReceiveCaret(
  element: HTMLElement,
  deletedBlocks: Set<HTMLElement>
): boolean {
  return (
    !deletedBlocks.has(element) &&
    !element.classList.contains('vmd-details-closer') &&
    !element.classList.contains('vmd-details-content--hidden')
  )
}

function findSiblingFocusTarget(
  first: HTMLElement,
  last: HTMLElement,
  deletedBlocks: Set<HTMLElement>
): FocusTarget | null {
  let next = last.nextElementSibling
  while (next) {
    if (
      next instanceof HTMLElement &&
      canReceiveCaret(next, deletedBlocks)
    ) {
      return { element: next, atStart: true }
    }
    next = next.nextElementSibling
  }

  let previous = first.previousElementSibling
  while (previous) {
    if (
      previous instanceof HTMLElement &&
      canReceiveCaret(previous, deletedBlocks)
    ) {
      return { element: previous, atStart: false }
    }
    previous = previous.previousElementSibling
  }

  return null
}

function deleteBlock(target: DeletableBlock): void {
  const internal = getVditorInternals()
  if (!internal || internal.currentMode !== 'wysiwyg') return

  const blocks = target.blocks.filter((block) => block.isConnected)
  if (blocks.length !== target.blocks.length || blocks.length === 0) return
  const first = blocks[0]
  const last = blocks[blocks.length - 1]
  const parent = first.parentElement
  if (
    !parent ||
    blocks.some((block) => block.parentElement !== parent)
  ) {
    return
  }

  const deletedBlocks = new Set(blocks)
  let focusTarget = findSiblingFocusTarget(first, last, deletedBlocks)
  if (!focusTarget && parent !== getWysiwygRoot()) {
    focusTarget = { element: parent, atStart: false }
  }

  if (!focusTarget) {
    const paragraph = document.createElement('p')
    paragraph.dataset.block = '0'
    paragraph.innerHTML = '<br>'
    parent.insertBefore(paragraph, last.nextSibling)
    focusTarget = { element: paragraph, atStart: true }
  }

  closeActiveWysiwygPopover()
  const popover = internal.wysiwyg?.popover
  if (popover instanceof HTMLElement) popover.style.display = 'none'

  blocks.forEach((block) => block.remove())
  if (!focusTarget.element.isConnected) return

  const range = document.createRange()
  range.selectNodeContents(focusTarget.element)
  range.collapse(focusTarget.atStart)
  focusVditorRange(range)
  commitVditorWysiwygDomEdit(internal)
}

/** Adds whole-region deletion for non-table WYSIWYG block types. */
export function initBlockContextMenu(): void {
  if (hideContextMenu) {
    hideContextMenu()
    return
  }

  const menu = createMenu()
  const label = menu.querySelector<HTMLElement>(
    '.vmd-table-context-menu__label'
  )
  let state: DeletableBlock | null = null

  const hide = () => {
    deactivateFloatingPanel(menu)
    menu.style.display = 'none'
    menu.style.visibility = ''
    menu.removeAttribute('data-kind')
    state = null
  }

  const show = (target: DeletableBlock, event: MouseEvent) => {
    state = target
    const text = labelFor(target.kind)
    if (label) label.textContent = text
    menu.setAttribute('aria-label', text)
    menu.dataset.kind = target.kind
    activateFloatingPanel({ panel: menu, onDismiss: hide })
    positionFloatingPanelAtPoint(menu, event.clientX, event.clientY)
  }

  document.addEventListener(
    'contextmenu',
    (event) => {
      const eventTarget =
        event.target instanceof Element ? event.target : null
      if (eventTarget?.closest(`#${MENU_ID}`)) {
        event.preventDefault()
        return
      }

      // The table menu is registered first and owns table-cell events.
      if (event.defaultPrevented || !eventTarget) {
        hide()
        return
      }

      const target = resolveDeletableBlock(eventTarget)
      if (!target) {
        hide()
        return
      }

      event.preventDefault()
      event.stopPropagation()
      show(target, event)
    },
    true
  )

  menu.addEventListener('mousedown', (event) => event.preventDefault())
  menu.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const eventTarget =
      event.target instanceof Element ? event.target : null
    const button = eventTarget?.closest<HTMLButtonElement>(
      'button[data-type="delete-block"]'
    )
    const current = state
    if (!button || !current) return
    hide()
    deleteBlock(current)
  })

  hideContextMenu = hide
}
