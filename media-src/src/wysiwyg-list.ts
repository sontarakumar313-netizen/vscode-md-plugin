import {
  focusVditorRange,
  getVditorInternals,
  indentVditorList,
  outdentVditorList,
} from './vditor-adapter'
import { registerWysiwygDomFeature } from './wysiwyg-dom'

type ListCommand = 'list' | 'ordered-list' | 'check'

type SelectionMarkers = {
  start: HTMLElement
  end?: HTMLElement
}

const LIST_ITEM_SELECTOR = 'li'
const LIST_INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, summary, audio, video, img, [contenteditable="false"]'
const LIST_NON_TEXT_SELECTOR =
  'button, input, select, textarea, summary, [contenteditable="false"]'

function eventElement(event: Event): Element | null {
  if (event.target instanceof Element) return event.target
  return event.target instanceof Node ? event.target.parentElement : null
}

function listItemAtPoint(
  event: MouseEvent,
  root: HTMLElement
): HTMLElement | null {
  const targetItem = eventElement(event)?.closest<HTMLElement>(LIST_ITEM_SELECTOR)
  const pointRange = document.caretRangeFromPoint?.(
    event.clientX,
    event.clientY
  )
  const pointElement = pointRange
    ? pointRange.startContainer instanceof Element
      ? pointRange.startContainer
      : pointRange.startContainer.parentElement
    : null
  const pointItem = pointElement?.closest<HTMLElement>(LIST_ITEM_SELECTOR)

  if (targetItem && root.contains(targetItem)) {
    // A nested list can paint over its parent LI. In that case the point
    // resolver identifies the inner row; otherwise trust the actual hit target
    // so an ambiguous blank area cannot jump to a neighboring list item.
    if (pointItem && targetItem.contains(pointItem)) return pointItem
    return targetItem
  }
  return pointItem && root.contains(pointItem) ? pointItem : null
}

function listItemTextNodes(item: HTMLElement): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    if (!text.textContent) continue
    const owner = text.parentElement?.closest<HTMLElement>(LIST_ITEM_SELECTOR)
    if (owner !== item) continue
    if (text.parentElement?.closest(LIST_NON_TEXT_SELECTOR)) continue
    nodes.push(text)
  }
  return nodes
}

function itemLineRects(item: HTMLElement): DOMRect[] {
  const rects: DOMRect[] = []
  for (const text of listItemTextNodes(item)) {
    const range = document.createRange()
    range.selectNodeContents(text)
    rects.push(...Array.from(range.getClientRects()))
  }
  return rects
}

function isTrailingBlankPoint(
  item: HTMLElement,
  event: PointerEvent | MouseEvent
): boolean {
  const target = eventElement(event)
  if (target?.closest(LIST_INTERACTIVE_SELECTOR)) return false

  const rects = itemLineRects(item)
  const lineRects = rects.filter(
    (rect) =>
      event.clientY >= rect.top - 1 && event.clientY <= rect.bottom + 1
  )
  if (lineRects.length === 0) return false
  const lineRight = Math.max(...lineRects.map((rect) => rect.right))
  return event.clientX > lineRight + 2
}

function placeCaretAtListItemEnd(item: HTMLElement, root: HTMLElement): void {
  const textNodes = listItemTextNodes(item)
  const range = document.createRange()
  const lastText = textNodes[textNodes.length - 1]
  if (lastText) {
    range.setStart(lastText, lastText.length)
    range.collapse(true)
  } else {
    range.selectNodeContents(item)
    range.collapse(false)
  }
  root.focus({ preventScroll: true })
  focusVditorRange(range)
}

export function initWysiwygListCaretPlacement(): void {
  registerWysiwygDomFeature({
    refresh: () => {},
    onPointerDown: (event, root) => {
      if (event.button !== 0) return false
      const item = listItemAtPoint(event, root)
      if (!item || !isTrailingBlankPoint(item, event)) return false
      event.preventDefault()
      event.stopImmediatePropagation()
      placeCaretAtListItemEnd(item, root)
      return true
    },
    onClick: (event, root) => {
      if (event.button !== 0) return false
      const item = listItemAtPoint(event, root)
      if (!item || !isTrailingBlankPoint(item, event)) return false
      event.preventDefault()
      event.stopImmediatePropagation()
      placeCaretAtListItemEnd(item, root)
      return true
    },
  })
}

function getWysiwygEditor(internal: any): HTMLElement | null {
  return internal?.wysiwyg?.element || null
}

function rangeBelongsToEditor(range: Range, editor: HTMLElement): boolean {
  const contains = (node: Node) => node === editor || editor.contains(node)
  return contains(range.startContainer) && contains(range.endContainer)
}

function getEditorRange(
  internal: any,
  editor: HTMLElement
): Range | null {
  const selection = window.getSelection()
  if (selection?.rangeCount) {
    const range = selection.getRangeAt(0)
    if (rangeBelongsToEditor(range, editor)) return range
  }

  const savedRange = internal?.wysiwyg?.range as Range | undefined
  return savedRange && rangeBelongsToEditor(savedRange, editor)
    ? savedRange.cloneRange()
    : null
}

function asElement(node: Node): HTMLElement | null {
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as HTMLElement)
    : node.parentElement
}

function closestInEditor(
  node: Node,
  selector: string,
  editor: HTMLElement
): HTMLElement | null {
  let element = asElement(node)
  while (element && element !== editor) {
    if (element.matches(selector)) return element
    element = element.parentElement
  }
  return null
}

function isListContainer(element: HTMLElement): boolean {
  return element.tagName === 'UL' || element.tagName === 'OL'
}

function isLogicalBlock(element: HTMLElement, editor: HTMLElement): boolean {
  if (element.tagName === 'LI') return true
  if (!element.hasAttribute('data-block') || isListContainer(element)) return false
  return !closestInEditor(element.parentElement || element, 'li', editor)
}

function getSelectedBlocks(editor: HTMLElement, range: Range): HTMLElement[] {
  if (range.collapsed) {
    const item = closestInEditor(range.startContainer, 'li', editor)
    if (item) return [item]
    const block = closestInEditor(
      range.startContainer,
      '[data-block="0"]',
      editor
    )
    return block && isLogicalBlock(block, editor) ? [block] : []
  }

  const selected = Array.from(
    editor.querySelectorAll<HTMLElement>('li, [data-block="0"]')
  ).filter((element) => {
    if (!isLogicalBlock(element, editor)) return false
    try {
      return range.intersectsNode(element)
    } catch (_) {
      return false
    }
  })

  // A range over nested blocks (for example paragraphs inside a blockquote)
  // intersects both the container and its children. Transform only the leaf
  // blocks so their enclosing Markdown structure is preserved.
  return selected.filter(
    (element) =>
      !selected.some(
        (candidate) => candidate !== element && element.contains(candidate)
      )
  )
}

function createMarker(role: 'start' | 'end'): HTMLElement {
  const marker = document.createElement('span')
  marker.dataset.vmdListSelection = role
  marker.setAttribute('aria-hidden', 'true')
  return marker
}

function markSelection(range: Range): SelectionMarkers {
  if (range.collapsed) {
    const start = createMarker('start')
    range.insertNode(start)
    return { start }
  }

  const endRange = range.cloneRange()
  endRange.collapse(false)
  const end = createMarker('end')
  endRange.insertNode(end)

  const startRange = range.cloneRange()
  startRange.collapse(true)
  const start = createMarker('start')
  startRange.insertNode(start)
  return { start, end }
}

function restoreSelection(markers: SelectionMarkers): void {
  try {
    // Anchor on whichever marker survived the rebuild. Either can be orphaned:
    // markSelection inserts at the raw range boundary, which may sit directly
    // inside a UL/OL between two items, and the list rebuild only carries LI
    // children over to the replacement -- so the old container, still holding
    // the marker, is discarded by replaceWith. Building a range out of detached
    // nodes makes addRange drop the caret instead of placing it.
    const end = markers.end?.isConnected ? markers.end : null
    const start = markers.start.isConnected ? markers.start : null
    const anchor = start || end
    if (!anchor) return

    const selection = window.getSelection()
    const range = document.createRange()
    range.setStartBefore(anchor)
    if (start && end) {
      range.setEndBefore(end)
    } else {
      range.collapse(true)
    }

    selection?.removeAllRanges()
    selection?.addRange(range)
  } finally {
    markers.end?.remove()
    markers.start.remove()
  }
}

function listType(list: HTMLElement): ListCommand {
  if (list.tagName === 'OL') return 'ordered-list'
  const hasTaskItem = Array.from(list.children).some(
    (child) =>
      child.tagName === 'LI' &&
      ((child as HTMLElement).classList.contains('vditor-task') ||
        !!child.querySelector(':scope > input[type="checkbox"]'))
  )
  return hasTaskItem ? 'check' : 'list'
}

function copyListAttributes(source: HTMLElement | null, target: HTMLElement): void {
  if (source) {
    for (const attribute of Array.from(source.attributes)) {
      if (attribute.name !== 'data-marker') {
        target.setAttribute(attribute.name, attribute.value)
      }
    }
  }
  target.setAttribute('data-block', '0')
  target.setAttribute('data-marker', target.tagName === 'OL' ? '1.' : '*')
}

function createList(command: ListCommand, source: HTMLElement | null): HTMLElement {
  const list = document.createElement(command === 'ordered-list' ? 'ol' : 'ul')
  copyListAttributes(source, list)
  return list
}

function directCheckbox(item: HTMLElement): HTMLInputElement | null {
  const first = item.firstElementChild
  return first instanceof HTMLInputElement && first.type === 'checkbox'
    ? first
    : null
}

function prepareListItem(item: HTMLElement, command: ListCommand): void {
  const checkbox = directCheckbox(item)
  const wasChecked = checkbox?.checked || checkbox?.hasAttribute('checked')

  if (command !== 'check') {
    checkbox?.remove()
    item.classList.remove('vditor-task')
    const firstText = item.firstChild
    if (firstText?.nodeType === Node.TEXT_NODE && firstText.textContent?.startsWith(' ')) {
      firstText.textContent = firstText.textContent.slice(1)
    }
    return
  }

  item.classList.add('vditor-task')
  if (checkbox) return

  const taskCheckbox = document.createElement('input')
  taskCheckbox.type = 'checkbox'
  if (wasChecked) {
    taskCheckbox.checked = true
    taskCheckbox.setAttribute('checked', 'checked')
  }
  item.insertBefore(taskCheckbox, item.firstChild)
  if (item.childNodes[1]?.nodeType === Node.TEXT_NODE) {
    const text = item.childNodes[1] as Text
    if (!text.textContent.startsWith(' ')) text.insertData(0, ' ')
  } else {
    item.insertBefore(document.createTextNode(' '), taskCheckbox.nextSibling)
  }
}

function listItemToParagraphs(item: HTMLElement): HTMLElement[] {
  directCheckbox(item)?.remove()
  item.classList.remove('vditor-task')

  const paragraph = document.createElement('p')
  paragraph.setAttribute('data-block', '0')
  const nestedLists: HTMLElement[] = []
  while (item.firstChild) {
    const child = item.firstChild
    if (child instanceof HTMLElement && isListContainer(child)) {
      nestedLists.push(child)
    } else {
      paragraph.appendChild(child)
    }
  }

  if (
    paragraph.firstChild?.nodeType === Node.TEXT_NODE &&
    paragraph.firstChild.textContent?.startsWith(' ')
  ) {
    paragraph.firstChild.textContent = paragraph.firstChild.textContent.slice(1)
  }
  return [paragraph, ...nestedLists]
}

function replaceSelectedListItems(
  list: HTMLElement,
  selected: Set<HTMLElement>,
  command: ListCommand
): void {
  const items = Array.from(list.children).filter(
    (child): child is HTMLElement => child.tagName === 'LI'
  )
  if (!items.some((item) => selected.has(item))) return

  const sourceType = listType(list)
  const removeListFormat = sourceType === command
  const fragment = document.createDocumentFragment()
  let index = 0

  while (index < items.length) {
    const selectedRun = selected.has(items[index])
    const run: HTMLElement[] = []
    while (index < items.length && selected.has(items[index]) === selectedRun) {
      run.push(items[index])
      index += 1
    }

    if (selectedRun && removeListFormat) {
      for (const item of run) {
        for (const paragraph of listItemToParagraphs(item)) {
          fragment.appendChild(paragraph)
        }
      }
      continue
    }

    const output = createList(selectedRun ? command : sourceType, list)
    for (const item of run) {
      if (selectedRun) prepareListItem(item, command)
      output.appendChild(item)
    }
    fragment.appendChild(output)
  }

  list.replaceWith(fragment)
}

function replacePlainBlocks(
  blocks: HTMLElement[],
  command: ListCommand
): void {
  let index = 0
  while (index < blocks.length) {
    const first = blocks[index]
    if (!first.isConnected) {
      index += 1
      continue
    }

    const run = [first]
    index += 1
    while (
      index < blocks.length &&
      blocks[index].isConnected &&
      blocks[index].parentElement === first.parentElement &&
      blocks[index].previousElementSibling === run[run.length - 1]
    ) {
      run.push(blocks[index])
      index += 1
    }

    const list = createList(command, null)
    for (const block of run) {
      const item = document.createElement('li')
      while (block.firstChild) item.appendChild(block.firstChild)
      prepareListItem(item, command)
      list.appendChild(item)
    }
    first.replaceWith(list)
    for (const block of run.slice(1)) block.remove()
  }
}

function notifyVditorOfListChange(internal: any, editor: HTMLElement): void {
  internal.outline?.render?.(internal)
  internal.wysiwyg.preventInput = true
  const event =
    typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true, inputType: 'insertText' })
      : new Event('input', { bubbles: true })
  editor.dispatchEvent(event)
}

function applyListCommand(vditor: any, command: ListCommand): boolean {
  const internal = getVditorInternals(vditor)
  const editor = getWysiwygEditor(internal)
  if (!editor || internal.currentMode !== 'wysiwyg') return false

  const range = getEditorRange(internal, editor)
  if (!range) return false
  const selectedBlocks = getSelectedBlocks(editor, range)
  if (!selectedBlocks.length) return false

  const markers = markSelection(range)
  const selectedByList = new Map<HTMLElement, Set<HTMLElement>>()
  const plainBlocks: HTMLElement[] = []

  for (const block of selectedBlocks) {
    if (block.tagName === 'LI' && isListContainer(block.parentElement as HTMLElement)) {
      const list = block.parentElement as HTMLElement
      const selected = selectedByList.get(list) || new Set<HTMLElement>()
      selected.add(block)
      selectedByList.set(list, selected)
    } else {
      plainBlocks.push(block)
    }
  }

  for (const [list, selected] of selectedByList) {
    replaceSelectedListItems(list, selected, command)
  }
  replacePlainBlocks(plainBlocks, command)
  restoreSelection(markers)
  notifyVditorOfListChange(internal, editor)
  return true
}

function toolbarButton(internal: any, command: string): HTMLElement | null {
  const toolbarItem = internal?.toolbar?.elements?.[command] as
    | HTMLElement
    | undefined
  return toolbarItem?.querySelector<HTMLElement>(
    `[data-type="${command}"]`
  ) || null
}

function applyListIndent(
  internal: any,
  item: HTMLElement,
  range: Range,
  outdent: boolean
): void {
  if (outdent) {
    outdentVditorList(internal, item, range, item.parentElement as HTMLElement)
  } else {
    indentVditorList(internal, item, range)
  }
}

function nativeListTabHandlesRange(range: Range, item: HTMLElement): boolean {
  // Mirror Vditor's own gate (fixBrowserBehavior fixList) exactly: it indents
  // on `isFirst || range.toString() !== ""`. `!range.collapsed` was a looser
  // proxy -- a range spanning only element boundaries is uncollapsed but has
  // empty text, so Vditor would fall through to fixTab and insert a literal
  // tab while we assumed it had handled the indent.
  if (range.toString() !== '') return true
  const start = range.startContainer
  if (
    range.startOffset === 0 &&
    ((start.nodeType === Node.TEXT_NODE && !start.previousSibling) ||
      (start.nodeType !== Node.TEXT_NODE && start.nodeName === 'LI'))
  ) {
    return true
  }

  return !!(
    item.classList.contains('vditor-task') &&
    range.startOffset === 1 &&
    start.previousSibling?.nodeType !== Node.TEXT_NODE &&
    (start.previousSibling as HTMLElement)?.tagName === 'INPUT'
  )
}

export function handleRenderedListTab(vditor: any, event: KeyboardEvent): boolean {
  if (
    event.key !== 'Tab' ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  ) {
    return false
  }

  const internal = getVditorInternals(vditor)
  if (internal?.currentMode !== 'wysiwyg') return false

  const editor = getWysiwygEditor(internal)
  if (!editor) return false

  const range = getEditorRange(internal, editor)
  if (!range) return false
  const item = closestInEditor(range.startContainer, 'li', editor)
  if (!item) return false

  // Keep VS Code from treating Tab as a workbench key while allowing Vditor's
  // own listener to handle cases it already supports.
  event.stopPropagation()
  if (nativeListTabHandlesRange(range, item)) return true

  event.preventDefault()
  queueMicrotask(() => {
    if (internal.currentMode !== 'wysiwyg') return
    const currentRange = getEditorRange(internal, editor)
    if (!currentRange) return
    const currentItem = closestInEditor(currentRange.startContainer, 'li', editor)
    if (!currentItem) return
    applyListIndent(internal, currentItem, currentRange, event.shiftKey)
  })
  return true
}

export function installWysiwygListCommands(vditor: any): void {
  const internal = getVditorInternals(vditor)
  if (!internal?.toolbar?.elements) return

  for (const command of ['list', 'ordered-list', 'check'] as ListCommand[]) {
    const button = toolbarButton(internal, command)
    if (!button || button.dataset.vmdListCommandBound === '1') continue
    button.dataset.vmdListCommandBound = '1'
    button.addEventListener(
      'click',
      (event) => {
        if (internal.currentMode !== 'wysiwyg') return
        if (!applyListCommand(vditor, command)) return
        event.preventDefault()
        event.stopImmediatePropagation()
      },
      true
    )
  }
}
