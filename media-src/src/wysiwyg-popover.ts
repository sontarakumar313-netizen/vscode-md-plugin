let pendingPopoverTarget: HTMLElement | null = null
let activePopoverPosition: {
  popover: HTMLElement
  target: HTMLElement
} | null = null
let popoverPositionListenersInstalled = false
let popoverPositionQueued = false
let activeDetailsTitleFinish: (() => void) | null = null
const POPOVER_POSITIONING_CLASS = 'vmd-url-popover--positioning'
const DETAILS_TITLE_POPOVER_CLASS = 'vmd-details-title-popover'

interface DetailsTitlePopoverOptions {
  popover: HTMLElement
  target: HTMLElement
  value: string
  label: string
  onInput: (value: string, event: InputEvent) => void
  onCompositionEnd: (value: string) => void
  onBlur: (value: string) => void
}

/** Records a click target before Vditor constructs its shared popover. */
export function setWysiwygPopoverTarget(target: HTMLElement): void {
  pendingPopoverTarget = target
}

/** Copies text without assuming that the Webview exposes Clipboard API access. */
async function copyText(content: string): Promise<boolean> {
  const writeText = navigator.clipboard?.writeText
  if (typeof writeText === 'function') {
    try {
      await writeText.call(navigator.clipboard, content)
      return true
    } catch (_) {
      // Fall through to execCommand for hosts that expose but deny Clipboard API.
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = content
  textarea.setAttribute('readonly', '')
  textarea.style.cssText =
    'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0'
  document.body.appendChild(textarea)
  textarea.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch (_) {
    copied = false
  }
  textarea.remove()
  return copied
}

function addUrlCopyButton(
  popover: HTMLElement,
  urlWrap: HTMLElement,
  urlInput: HTMLInputElement
): HTMLButtonElement {
  const i18n = (window as any).VditorI18n || {}
  const copyLabel = i18n.copy || 'Copy URL'
  const copiedLabel = i18n.copied || 'Copied'
  const failedLabel = 'Copy failed'
  const button = document.createElement('button')
  button.type = 'button'
  button.className =
    'vditor-icon vditor-tooltipped vditor-tooltipped__n vmd-popover-copy-url'
  button.setAttribute('aria-label', copyLabel)
  button.innerHTML = '<svg><use xlink:href="#vditor-icon-copy"></use></svg>'
  button.addEventListener('click', async (event) => {
    event.preventDefault()
    event.stopPropagation()
    const copied = await copyText(urlInput.value)
    button.setAttribute('aria-label', copied ? copiedLabel : failedLabel)
    window.setTimeout(() => {
      if (button.isConnected) button.setAttribute('aria-label', copyLabel)
    }, 1500)
  })
  urlWrap.insertAdjacentElement('afterend', button)
  popover.classList.add('vmd-url-popover')
  urlWrap.classList.add('vmd-url-popover__url')
  urlInput.classList.add('vmd-url-popover__url-input')
  return button
}

function hideField(field: HTMLElement | undefined): void {
  if (!field) return
  field.classList.add('vmd-url-popover__hidden-field')
  field.setAttribute('aria-hidden', 'true')
}

function queueActivePopoverPosition(): void {
  if (popoverPositionQueued) return
  popoverPositionQueued = true
  // Vditor applies its provisional position immediately after invoking the
  // customization callback. Run at the end of the same task, before the next
  // browser paint, so only the measured above-target position becomes visible.
  queueMicrotask(() => {
    popoverPositionQueued = false
    const active = activePopoverPosition
    if (!active) return
    const { popover, target } = active
    if (
      !popover.isConnected ||
      !target.isConnected ||
      popover.style.display !== 'block'
    ) {
      popover.classList.remove(POPOVER_POSITIONING_CLASS)
      activePopoverPosition = null
      return
    }
    const editor = popover.parentElement
    if (!(editor instanceof HTMLElement)) {
      popover.classList.remove(POPOVER_POSITIONING_CLASS)
      activePopoverPosition = null
      return
    }
    const editorRect = editor.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const gap = 6
    const targetTop = targetRect.top - editorRect.top + editor.scrollTop
    const targetLeft = targetRect.left - editorRect.left + editor.scrollLeft
    const maxLeft = Math.max(
      0,
      editor.scrollLeft + editor.clientWidth - popover.offsetWidth
    )
    popover.style.left = `${Math.max(
      editor.scrollLeft,
      Math.min(targetLeft, maxLeft)
    )}px`
    // Vditor clamps its panel to -8px, which overlaps first-line targets. The
    // WYSIWYG container does not clip overflow, so retain the actual measured
    // above-target coordinate even when it is negative.
    popover.style.top = `${targetTop - popover.offsetHeight - gap}px`
    popover.dataset.vmdPosition = 'above'
    popover.classList.remove(POPOVER_POSITIONING_CLASS)
    if (pendingPopoverTarget === target) pendingPopoverTarget = null
  })
}

function installPopoverPositionListeners(): void {
  if (popoverPositionListenersInstalled) return
  popoverPositionListenersInstalled = true
  // Vditor rewrites the shared panel's top position from a fixed 21px formula
  // when the editor scrolls. Re-apply measured positioning after its handler.
  document.addEventListener('scroll', queueActivePopoverPosition, true)
  window.addEventListener('resize', queueActivePopoverPosition)
}

function positionAboveTarget(
  popover: HTMLElement,
  target: HTMLElement | null
): void {
  if (!target || !target.isConnected) return
  popover.classList.add(POPOVER_POSITIONING_CLASS)
  activePopoverPosition = { popover, target }
  installPopoverPositionListeners()
  queueActivePopoverPosition()
}

function getPopoverTarget(type: string): HTMLElement | null {
  const selection = window.getSelection()
  let element = selection?.anchorNode instanceof Element
    ? selection.anchorNode
    : selection?.anchorNode?.parentElement
  if (type === 'a') return element?.closest('a') || null
  if (type === 'image') {
    const active = document.activeElement
    if (active instanceof HTMLImageElement) return active
    return pendingPopoverTarget instanceof HTMLImageElement &&
      pendingPopoverTarget.isConnected
      ? pendingPopoverTarget
      : null
  }
  return null
}

function redirectHiddenLinkFocus(
  urlInput: HTMLInputElement,
  target: HTMLElement | null
): void {
  window.setTimeout(() => {
    const active = document.activeElement
    const hiddenFieldFocused =
      active instanceof HTMLElement &&
      !!active.closest('.vmd-url-popover__hidden-field')
    // Toolbar insertion creates a temporary empty-href/ZWSP anchor, then may
    // focus the hidden text input after this callback returns. Existing links
    // have a real href and must keep their ordinary text caret.
    const insertingEmptyLink =
      target instanceof HTMLAnchorElement && !target.getAttribute('href')
    if (hiddenFieldFocused || insertingEmptyLink) {
      urlInput.focus()
      urlInput.select()
    }
  }, 0)
}

function installLinkPopoverTabOrder(
  urlInput: HTMLInputElement,
  copyButton: HTMLButtonElement
): void {
  urlInput.onkeydown = (event) => {
    if (event.key !== 'Tab') return
    event.preventDefault()
    event.stopPropagation()
    if (!event.shiftKey) copyButton.focus()
  }
  copyButton.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || !event.shiftKey) return
    event.preventDefault()
    event.stopPropagation()
    urlInput.focus()
  })
}

export function finishDetailsTitlePopover(): void {
  const finish = activeDetailsTitleFinish
  activeDetailsTitleFinish = null
  finish?.()
}

/** Opens a single-line details-title editor in Vditor's shared URL popover. */
export function showDetailsTitlePopover({
  popover,
  target,
  value,
  label,
  onInput,
  onCompositionEnd,
  onBlur,
}: DetailsTitlePopoverOptions): HTMLInputElement {
  finishDetailsTitlePopover()
  activePopoverPosition = null
  popover.replaceChildren()
  popover.classList.remove(
    'vmd-url-popover--image',
    'vmd-wysiwyg-popover--empty',
    POPOVER_POSITIONING_CLASS
  )
  popover.classList.add('vmd-url-popover', DETAILS_TITLE_POPOVER_CLASS)
  delete popover.dataset.vmdPosition

  const inputWrap = document.createElement('span')
  inputWrap.className = 'vditor-tooltipped vditor-tooltipped__n vmd-url-popover__url'
  inputWrap.setAttribute('aria-label', label)
  const input = document.createElement('input')
  input.className = 'vditor-input vmd-url-popover__url-input'
  input.type = 'text'
  input.value = value
  input.placeholder = label
  input.setAttribute('aria-label', label)
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    if (activeDetailsTitleFinish === finish) activeDetailsTitleFinish = null
    onBlur(input.value)
  }
  activeDetailsTitleFinish = finish
  input.addEventListener('input', (event) => {
    if (event instanceof InputEvent) onInput(input.value, event)
  })
  input.addEventListener('compositionend', () => onCompositionEnd(input.value))
  input.addEventListener('blur', finish)
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) {
      event.stopImmediatePropagation()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      input.blur()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      popover.style.display = 'none'
      target.focus()
    }
    event.stopPropagation()
  })
  inputWrap.appendChild(input)
  popover.appendChild(inputWrap)

  positionAboveTarget(popover, target)
  popover.style.display = 'block'
  input.focus()
  input.select()
  return input
}

/**
 * Removes unwanted native controls from Vditor's WYSIWYG popover. Table
 * actions are provided by the shared right-click menu instead.
 */
export function customizeWysiwygPopover(
  type: string,
  popover: HTMLElement
): void {
  finishDetailsTitlePopover()
  // Vditor reuses one popover element for every context.
  popover.classList.remove(
    'vmd-url-popover',
    'vmd-url-popover--image',
    DETAILS_TITLE_POPOVER_CLASS,
    POPOVER_POSITIONING_CLASS
  )
  delete popover.dataset.vmdPosition
  activePopoverPosition = null
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
    // Vditor's closures still read all three native inputs, so keep them in the
    // DOM while exposing only href + copy. Empty-link insertion initially
    // focuses the now-hidden text field; redirect that focus to href.
    const fields = Array.from(
      popover.querySelectorAll<HTMLElement>(':scope > span.vditor-tooltipped')
    )
    const urlInput = fields[1]?.querySelector<HTMLInputElement>('input')
    hideField(fields[0])
    hideField(fields[2])
    if (fields[1] && urlInput) {
      const copyButton = addUrlCopyButton(popover, fields[1], urlInput)
      installLinkPopoverTabOrder(urlInput, copyButton)
      const target = getPopoverTarget(type)
      redirectHiddenLinkFocus(urlInput, target)
      positionAboveTarget(popover, target)
    }
  } else if (type === 'image') {
    // Preserve the alt input object for Vditor's update closure while removing
    // it visually. Keep a wide URL editor, URL copy action, and title editor.
    const fields = Array.from(
      popover.querySelectorAll<HTMLElement>(':scope > span.vditor-tooltipped')
    )
    const urlInput = fields[0]?.querySelector<HTMLInputElement>('input')
    hideField(fields[1])
    fields[2]?.classList.add('vmd-url-popover__title')
    if (fields[0] && urlInput) {
      addUrlCopyButton(popover, fields[0], urlInput)
      positionAboveTarget(popover, getPopoverTarget(type))
    }
    popover.classList.add('vmd-url-popover--image')
  }

  popover.classList.toggle(
    'vmd-wysiwyg-popover--empty',
    popover.childElementCount === 0 && popover.textContent.trim() === ''
  )
}
