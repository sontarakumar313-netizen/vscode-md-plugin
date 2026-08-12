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
  } else if (type === 'a') {
    // Keep only the href/URL field; remove link-text and title inputs.
    // genAPopover inserts: [0] text-content span, [1] href span, [2] title span.
    const spans = Array.from(
      popover.querySelectorAll<HTMLElement>(':scope > span.vditor-tooltipped')
    )
    if (spans.length >= 3) {
      spans[0].remove() // link text — not needed
      spans[2].remove() // title    — not needed
    }
    // Widen the surviving href input now that the other fields are gone.
    const hrefInput = popover.querySelector<HTMLInputElement>('input.vditor-input')
    if (hrefInput) hrefInput.style.width = '200px'
    // Add a one-click copy-URL button.
    const copyBtn = document.createElement('button')
    copyBtn.type = 'button'
    copyBtn.className = 'vditor-icon vditor-tooltipped vditor-tooltipped__n'
    copyBtn.setAttribute('aria-label', 'Copy URL')
    copyBtn.innerHTML = '<svg><use xlink:href="#vditor-icon-copy"></use></svg>'
    copyBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const url = hrefInput?.value ?? ''
      navigator.clipboard?.writeText(url).catch(() => {
        const ta = document.createElement('textarea')
        ta.value = url
        ta.style.cssText = 'position:fixed;opacity:0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
      })
      copyBtn.setAttribute('aria-label', 'Copied!')
      setTimeout(() => copyBtn.setAttribute('aria-label', 'Copy URL'), 1500)
    })
    popover.appendChild(copyBtn)
  } else if (type === 'image') {
    // Remove the alternate-text (alt) field; keep src URL and title.
    // genImagePopover inserts: [0] imageURL span, [1] alternateText span, [2] title span.
    const spans = Array.from(
      popover.querySelectorAll<HTMLElement>(':scope > span.vditor-tooltipped')
    )
    if (spans.length >= 2) spans[1].remove()
    // Widen the popover so a long URL fits comfortably.
    popover.style.minWidth = '300px'
  }

  popover.classList.toggle(
    'vmd-wysiwyg-popover--empty',
    popover.childElementCount === 0 && popover.textContent.trim() === ''
  )
}
