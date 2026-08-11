/**
 * Removes unwanted native controls from Vditor's WYSIWYG popover. Table
 * actions are provided by the shared right-click menu instead.
 */
export function customizeWysiwygPopover(
  type: string,
  popover: HTMLElement
): void {
  popover
    .querySelectorAll(
      '[data-type="up"], [data-type="down"], [data-type="remove"]'
    )
    .forEach((action) => action.remove())

  if (type === 'heading') {
    popover
      .querySelector<HTMLInputElement>('input[placeholder^="ID"]')
      ?.parentElement?.remove()
  } else if (type === 'table') {
    // Prevent the native floating table toolbar from duplicating the context
    // menu, including its row/column count inputs.
    popover.replaceChildren()
  }

  popover.classList.toggle(
    'vmd-wysiwyg-popover--empty',
    popover.childElementCount === 0 && popover.textContent.trim() === ''
  )
}
