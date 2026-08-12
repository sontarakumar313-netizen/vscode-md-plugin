import {
  focusVditorRange,
  getVditorInternals,
  vditorTableActions,
} from './vditor-adapter'
import { t } from './lang'

const MENU_ID = 'vmd-table-context-menu'

type TableAction =
  | 'left'
  | 'center'
  | 'right'
  | 'insertRowAbove'
  | 'insertRowBelow'
  | 'insertColumnLeft'
  | 'insertColumnRight'
  | 'deleteRow'
  | 'deleteColumn'
  | 'deleteTable'

interface MenuState {
  cell: HTMLTableCellElement
  range: Range | null
}

interface ContextMenuApi {
  hide(): void
}

function icon(name: string): string {
  return `<svg aria-hidden="true"><use xlink:href="#vditor-icon-${name}"></use></svg>`
}

function getActionRange(state: MenuState): Range {
  if (
    state.range &&
    state.range.startContainer.isConnected &&
    state.cell.contains(state.range.startContainer)
  ) {
    return state.range.cloneRange()
  }

  const range = document.createRange()
  range.selectNodeContents(state.cell)
  range.collapse(false)
  return range
}

function isWysiwygCell(cell: HTMLTableCellElement): boolean {
  return !!cell.closest('.vditor-wysiwyg .vditor-reset')
}

function createMenu(): HTMLDivElement {
  const i18n: any = window.VditorI18n || {}
  const label = (key: string, fallback: string) => i18n[key] || fallback
  const item = (
    action: TableAction,
    text: string,
    iconName: string,
    className = ''
  ) => `<button type="button" role="menuitem" data-type="${action}" class="${className}">
    <span class="vmd-table-context-menu__icon">${icon(iconName)}</span>
    <span class="vmd-table-context-menu__label">${text}</span>
  </button>`

  const menu = document.createElement('div')
  menu.id = MENU_ID
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', label('table', 'Table'))
  menu.innerHTML = `
    ${item('left', label('alignLeft', 'Align left'), 'align-left')}
    ${item('center', label('alignCenter', 'Align center'), 'align-center')}
    ${item('right', label('alignRight', 'Align right'), 'align-right')}
    <div class="vmd-table-context-menu__separator" role="separator"></div>
    ${item('insertRowAbove', label('insertRowAbove', 'Insert row above'), 'insert-rowb')}
    ${item('insertRowBelow', label('insertRowBelow', 'Insert row below'), 'insert-row')}
    ${item('insertColumnLeft', label('insertColumnLeft', 'Insert column left'), 'insert-columnb')}
    ${item('insertColumnRight', label('insertColumnRight', 'Insert column right'), 'insert-column')}
    <div class="vmd-table-context-menu__separator" role="separator"></div>
    ${item('deleteRow', label('delete-row', 'Delete row'), 'delete-row', 'vmd-table-context-menu__danger')}
    ${item('deleteColumn', label('delete-column', 'Delete column'), 'delete-column', 'vmd-table-context-menu__danger')}
    ${item('deleteTable', t('deleteTable'), 'trashcan', 'vmd-table-context-menu__danger')}
  `
  document.body.appendChild(menu)
  return menu
}

function setAlignState(
  menu: HTMLElement,
  cell: HTMLTableCellElement
): void {
  const align = cell.getAttribute('align') ||
    (cell.tagName === 'TH' ? 'center' : 'left')

  menu
    .querySelectorAll<HTMLElement>(
      '[data-type="left"], [data-type="center"], [data-type="right"]'
    )
    .forEach((item) => {
      item.classList.toggle('vmd-table-context-menu__current', item.dataset.type === align)
    })
}

function positionMenu(menu: HTMLElement, clientX: number, clientY: number): void {
  const margin = 8
  menu.style.display = 'block'
  menu.style.visibility = 'hidden'
  menu.style.left = '0'
  menu.style.top = '0'

  const maxLeft = Math.max(margin, window.innerWidth - menu.offsetWidth - margin)
  const maxTop = Math.max(margin, window.innerHeight - menu.offsetHeight - margin)
  menu.style.left = `${Math.min(Math.max(clientX, margin), maxLeft)}px`
  menu.style.top = `${Math.min(Math.max(clientY, margin), maxTop)}px`
  menu.style.visibility = 'visible'
}

function deleteTable(
  internal: any,
  table: HTMLTableElement,
  range: Range
): void {
  let focusTarget = [
    table.previousElementSibling,
    table.nextElementSibling,
  ].find(
    (element): element is HTMLElement => element instanceof HTMLElement
  )

  if (!focusTarget) {
    focusTarget = document.createElement('p')
    focusTarget.dataset.block = '0'
    focusTarget.innerHTML = '<br>'
    table.insertAdjacentElement('afterend', focusTarget)
  }

  range.selectNodeContents(focusTarget)
  range.collapse(true)
  table.remove()
  focusVditorRange(range)
  vditorTableActions.execAfterRender(internal)
}

/**
 * Replaces the floating WYSIWYG table toolbar with one context menu. The cell
 * under the mouse is captured before the menu opens so
 * every action targets that row/column even when the editor selection is stale.
 */
export function initTableContextMenu(): void {
  const existing = (window as any).__vmdTableContextMenu as
    | ContextMenuApi
    | undefined
  if (existing) {
    existing.hide()
    return
  }

  const menu = createMenu()
  let state: MenuState | null = null

  const hide = () => {
    menu.style.display = 'none'
    menu.style.visibility = ''
    state = null
  }

  const show = (
    cell: HTMLTableCellElement,
    event: MouseEvent
  ) => {
    const selection = window.getSelection()
    const selectedRange =
      selection &&
      selection.rangeCount > 0 &&
      cell.contains(selection.getRangeAt(0).startContainer)
        ? selection.getRangeAt(0).cloneRange()
        : null

    state = { cell, range: selectedRange }
    setAlignState(menu, cell)

    const deleteRowButton = menu.querySelector<HTMLButtonElement>(
      '[data-type="deleteRow"]'
    )
    if (deleteRowButton) {
      deleteRowButton.disabled = cell.tagName === 'TH'
    }

    positionMenu(menu, event.clientX, event.clientY)
  }

  const execute = (action: TableAction) => {
    const current = state
    const internal = getVditorInternals()
    if (
      !current ||
      !internal ||
      !current.cell.isConnected ||
      internal.currentMode !== 'wysiwyg'
    ) {
      hide()
      return
    }

    const cell = current.cell
    const table = cell.closest<HTMLTableElement>('table')
    if (!table) {
      hide()
      return
    }

    const range = getActionRange(current)
    focusVditorRange(range)

    switch (action) {
      case 'left':
      case 'center':
      case 'right': {
        const columnIndex = cell.cellIndex
        Array.from(table.rows).forEach((row) => {
          row.cells[columnIndex]?.setAttribute('align', action)
        })
        vditorTableActions.execAfterRender(internal)
        break
      }
      case 'insertRowAbove':
        vditorTableActions.insertRowAbove(internal, range, cell)
        break
      case 'insertRowBelow':
        vditorTableActions.insertRow(internal, range, cell)
        break
      case 'insertColumnLeft':
        vditorTableActions.insertColumn(internal, table, cell, 'beforebegin')
        break
      case 'insertColumnRight':
        vditorTableActions.insertColumn(internal, table, cell)
        break
      case 'deleteRow':
        if (cell.tagName !== 'TH') vditorTableActions.deleteRow(internal, range, cell)
        break
      case 'deleteColumn':
        vditorTableActions.deleteColumn(internal, range, table, cell)
        break
      case 'deleteTable':
        deleteTable(internal, table, range)
        break
    }

    hide()
  }

  document.addEventListener(
    'contextmenu',
    (event) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(`#${MENU_ID}`)) {
        event.preventDefault()
        return
      }

      const cell = target?.closest<HTMLTableCellElement>('td, th') || null
      if (!cell || !isWysiwygCell(cell)) {
        hide()
        return
      }

      event.preventDefault()
      event.stopPropagation()
      show(cell, event)
    },
    true
  )

  menu.addEventListener('mousedown', (event) => event.preventDefault())
  menu.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest<HTMLButtonElement>('button[data-type]')
    if (!button || button.disabled) return
    execute(button.dataset.type as TableAction)
  })

  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target?.closest(`#${MENU_ID}`)) hide()
    },
    true
  )
  document.addEventListener('scroll', hide, true)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide()
  })
  window.addEventListener('resize', hide)
  window.addEventListener('blur', hide)

  ;(window as any).__vmdTableContextMenu = { hide } as ContextMenuApi
}
