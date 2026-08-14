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
import { openWysiwygBlockSourceEditor } from './wysiwyg-source-editor'

const MENU_ID = 'vmd-block-context-menu'
const DIRECT_BLOCK_SELECTOR = [
  'blockquote',
  '.vditor-wysiwyg__block[data-type="code-block"]',
  '.vditor-wysiwyg__block[data-type="math-block"]',
  '.vditor-wysiwyg__block[data-type="html-block"]',
].join(', ')

type BlockContextKind =
  | 'quote'
  | 'alert'
  | 'details'
  | 'code-block'
  | 'math-block'
  | 'html-block'

interface BlockContextTarget {
  kind: BlockContextKind
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

function deleteLabelFor(kind: BlockContextKind): string {
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
    case 'html-block':
      return t('deleteHtmlBlock')
  }
}

function editLabelFor(kind: BlockContextKind): string | null {
  if (kind === 'html-block') return t('editHtmlSource')
  return kind === 'code-block' || kind === 'math-block'
    ? t('editSource')
    : null
}

function menuButton(
  type: 'edit-block-source' | 'delete-block',
  label: string
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('role', 'menuitem')
  button.dataset.type = type
  if (type === 'delete-block') {
    button.className = 'vmd-table-context-menu__danger'
  }

  const iconElement = document.createElement('span')
  iconElement.className = 'vmd-table-context-menu__icon'
  iconElement.innerHTML = type === 'delete-block'
    ? icon('trashcan')
    : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.7 1.8a1.4 1.4 0 0 1 2 2l-8.4 8.4-3 .6.6-3 8.8-8z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>'

  const labelElement = document.createElement('span')
  labelElement.className = 'vmd-table-context-menu__label'
  labelElement.textContent = label
  button.append(iconElement, labelElement)
  return button
}

function createMenu(): HTMLDivElement {
  const menu = document.createElement('div')
  menu.id = MENU_ID
  menu.setAttribute('role', 'menu')
  document.body.appendChild(menu)
  return menu
}

function directBlockKind(block: HTMLElement): BlockContextKind | null {
  if (block.tagName === 'BLOCKQUOTE') {
    return block.classList.contains('vmd-alert') ||
      block.hasAttribute('data-vmd-alert')
      ? 'alert'
      : 'quote'
  }

  const type = block.dataset.type
  if (type === 'html-block') {
    return block.classList.contains('vmd-details-opener') ||
      block.classList.contains('vmd-details-closer')
      ? null
      : type
  }
  if (type === 'code-block' || type === 'math-block') {
    return type
  }
  return null
}

function resolveContextTarget(target: Element): BlockContextTarget | null {
  const root = getWysiwygRoot()
  if (!root || !root.contains(target)) return null

  // A directly hit nested region wins over a containing details group. For
  // example, right-clicking a quote inside an expanded details block deletes
  // the quote, while right-clicking ordinary details content deletes details.
  const direct = target.closest<HTMLElement>(DIRECT_BLOCK_SELECTOR)
  if (direct && root.contains(direct)) {
    if (
      direct.dataset.type === 'html-block' &&
      !direct.classList.contains('vmd-details-opener') &&
      !direct.classList.contains('vmd-details-closer')
    ) {
      return { kind: 'html-block', blocks: [direct] }
    }
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

export function deleteWysiwygBlocks(
  targetBlocks: readonly HTMLElement[]
): boolean {
  const internal = getVditorInternals()
  if (!internal || internal.currentMode !== 'wysiwyg') return false

  const blocks = targetBlocks.filter((block) => block.isConnected)
  if (blocks.length !== targetBlocks.length || blocks.length === 0) return false
  const first = blocks[0]
  const last = blocks[blocks.length - 1]
  const parent = first.parentElement
  if (
    !parent ||
    blocks.some((block) => block.parentElement !== parent)
  ) {
    return false
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
  if (!focusTarget.element.isConnected) return false

  const range = document.createRange()
  range.selectNodeContents(focusTarget.element)
  range.collapse(focusTarget.atStart)
  focusVditorRange(range)
  commitVditorWysiwygDomEdit(internal)
  return true
}

/** Adds type-specific source editing and safe deletion to the block menu. */
export function initBlockContextMenu(): void {
  if (hideContextMenu) {
    hideContextMenu()
    return
  }

  const menu = createMenu()
  let state: BlockContextTarget | null = null

  const hide = () => {
    deactivateFloatingPanel(menu)
    menu.style.display = 'none'
    menu.style.visibility = ''
    menu.removeAttribute('data-kind')
    state = null
  }

  const show = (target: BlockContextTarget, event: MouseEvent) => {
    state = target
    const editLabel = editLabelFor(target.kind)
    const deleteLabel = deleteLabelFor(target.kind)
    const actions: HTMLElement[] = []
    if (editLabel) {
      actions.push(menuButton('edit-block-source', editLabel))
      const separator = document.createElement('div')
      separator.className = 'vmd-table-context-menu__separator'
      separator.setAttribute('role', 'separator')
      actions.push(separator)
    }
    actions.push(menuButton('delete-block', deleteLabel))
    menu.replaceChildren(...actions)
    menu.setAttribute(
      'aria-label',
      editLabel ? `${editLabel}; ${deleteLabel}` : deleteLabel
    )
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

      const target = resolveContextTarget(eventTarget)
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
    const button = eventTarget?.closest<HTMLButtonElement>('button[data-type]')
    const current = state
    if (!button || !current) return
    hide()
    if (button.dataset.type === 'edit-block-source') {
      const block = current.blocks[0]
      if (current.kind === 'code-block') {
        block
          ?.querySelector<HTMLButtonElement>('.vmd-source-edit-button')
          ?.click()
      } else if (
        block &&
        (current.kind === 'math-block' || current.kind === 'html-block')
      ) {
        openWysiwygBlockSourceEditor(block)
      }
    } else if (button.dataset.type === 'delete-block') {
      deleteWysiwygBlocks(current.blocks)
    }
  })

  hideContextMenu = hide
}
