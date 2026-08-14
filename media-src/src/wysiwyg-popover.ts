import { cancelPendingVditorWysiwygToolbar } from './vditor-adapter'

let pendingPopoverTarget: HTMLElement | null = null
let activePopoverPosition: {
  popover: HTMLElement
  target: HTMLElement
} | null = null
let activeCustomPopover: {
  popover: HTMLElement
  target: HTMLElement | null
  editorRoot: HTMLElement | null
  finish: (() => void) | null
} | null = null
let popoverPositionListenersInstalled = false
let popoverPositionQueued = false
let activeDetailsTitleFinish: (() => void) | null = null
const POPOVER_POSITIONING_CLASS = 'vmd-url-popover--positioning'
const PERSISTENT_POPOVER_CLASS = 'vmd-url-popover--persistent'
const DETAILS_TITLE_POPOVER_CLASS = 'vmd-details-title-popover'
const SOURCE_POPOVER_CLASS = 'vmd-source-popover'

interface DetailsTitlePopoverOptions {
  popover: HTMLElement
  target: HTMLElement
  value: string
  label: string
  onInput: (value: string, event: InputEvent) => void
  onCompositionEnd: (value: string) => void
  onBlur: (value: string) => void
}

export interface WysiwygSourcePopoverField {
  name: string
  label: string
  value: string
  multiline?: boolean
  spellcheck?: boolean
}

interface WysiwygSourcePopoverOptions {
  popover: HTMLElement
  target: HTMLElement
  fields: WysiwygSourcePopoverField[]
  focusField?: string
  onChange: (values: Readonly<Record<string, string>>) => string | null
  onFinish: (values: Readonly<Record<string, string>>, changed: boolean) => void
}

/** Records a click target before Vditor constructs its shared popover. */
export function setWysiwygPopoverTarget(target: HTMLElement): void {
  pendingPopoverTarget = target
}

function popoverLabel(
  key: 'close' | 'copied' | 'copy',
  fallback: string
): string {
  const i18n = (window as Window & { VditorI18n?: unknown }).VditorI18n
  if (!i18n || typeof i18n !== 'object') return fallback
  const value = (i18n as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value : fallback
}

function cancelDelayedNativePopoverRefresh(): void {
  const active = activeCustomPopover
  if (active) cancelPendingVditorWysiwygToolbar(active.popover)
}

function deactivateCustomPopover(): typeof activeCustomPopover {
  const active = activeCustomPopover
  if (!active) return null
  active.editorRoot?.removeEventListener(
    'click',
    cancelDelayedNativePopoverRefresh
  )
  active.editorRoot?.removeEventListener(
    'keyup',
    cancelDelayedNativePopoverRefresh
  )
  document.removeEventListener('keydown', handlePersistentPopoverKeydown, true)
  document.removeEventListener(
    'pointerdown',
    handlePersistentPopoverPointerDown,
    true
  )
  active.popover.classList.remove(PERSISTENT_POPOVER_CLASS)
  activeCustomPopover = null
  return active
}

function deactivateAndFinishCustomPopover(): typeof activeCustomPopover {
  const active = deactivateCustomPopover()
  active?.finish?.()
  return active
}

function restorePopoverFocus(
  target: HTMLElement | null,
  editorRoot: HTMLElement | null
): void {
  if (target?.isConnected) {
    target.focus({ preventScroll: true })
    if (document.activeElement === target) return
    if (
      editorRoot?.contains(target) &&
      target.matches(
        '.vmd-source-owned, [data-type="code-block"], [data-type="yaml-front-matter"]'
      )
    ) {
      const range = document.createRange()
      range.selectNode(target)
      range.collapse(false)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
  }
  editorRoot?.focus({ preventScroll: true })
}

export function closeActiveWysiwygPopover(restoreFocus = false): void {
  const active = deactivateAndFinishCustomPopover()
  if (active) {
    active.popover.style.display = 'none'
    active.popover.classList.remove(POPOVER_POSITIONING_CLASS)
    if (activePopoverPosition?.popover === active.popover) {
      activePopoverPosition = null
    }
    if (pendingPopoverTarget === active.target) pendingPopoverTarget = null
  }
  finishDetailsTitlePopover()
  if (active && restoreFocus) {
    restorePopoverFocus(active.target, active.editorRoot)
  }
}

function closePopover(popover: HTMLElement): void {
  if (activeCustomPopover?.popover !== popover) return
  closeActiveWysiwygPopover(true)
}

function handlePersistentPopoverKeydown(event: KeyboardEvent): void {
  if (
    event.key !== 'Escape' ||
    event.isComposing ||
    event.keyCode === 229 ||
    !activeCustomPopover
  ) {
    return
  }
  event.preventDefault()
  event.stopImmediatePropagation()
  closeActiveWysiwygPopover(true)
}

function handlePersistentPopoverPointerDown(event: PointerEvent): void {
  const active = activeCustomPopover
  const target = event.target
  if (!active || !(target instanceof Node) || active.popover.contains(target)) {
    return
  }
  closeActiveWysiwygPopover(false)
}

function activateCustomPopover(
  popover: HTMLElement,
  target: HTMLElement | null,
  finish: (() => void) | null = null
): void {
  deactivateAndFinishCustomPopover()
  const editorRoot = popover.parentElement?.querySelector<HTMLElement>(
    ':scope > .vditor-reset'
  ) ?? null
  activeCustomPopover = { popover, target, editorRoot, finish }
  popover.classList.add(PERSISTENT_POPOVER_CLASS)
  editorRoot?.addEventListener('click', cancelDelayedNativePopoverRefresh)
  editorRoot?.addEventListener('keyup', cancelDelayedNativePopoverRefresh)
  document.addEventListener('keydown', handlePersistentPopoverKeydown, true)
  document.addEventListener(
    'pointerdown',
    handlePersistentPopoverPointerDown,
    true
  )
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
  const copyLabel = popoverLabel('copy', 'Copy URL')
  const copiedLabel = popoverLabel('copied', 'Copied')
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

function addPopoverCloseButton(
  popover: HTMLElement,
  after: HTMLElement
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className =
    'vditor-icon vditor-tooltipped vditor-tooltipped__n vmd-popover-close'
  button.setAttribute('aria-label', popoverLabel('close', 'Close'))
  button.textContent = '×'
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopImmediatePropagation()
    closePopover(popover)
  })
  after.insertAdjacentElement('afterend', button)
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
    const aboveTop = targetTop - popover.offsetHeight - gap
    if (popover.classList.contains(SOURCE_POPOVER_CLASS)) {
      const belowTop =
        targetRect.bottom - editorRect.top + editor.scrollTop + gap
      const visibleTop = editor.scrollTop - editorRect.top + 8
      const visibleBottom = visibleTop + window.innerHeight - 16
      if (aboveTop >= visibleTop) {
        popover.style.top = `${aboveTop}px`
        popover.dataset.vmdPosition = 'above'
      } else if (belowTop + popover.offsetHeight <= visibleBottom) {
        popover.style.top = `${belowTop}px`
        popover.dataset.vmdPosition = 'below'
      } else {
        popover.style.top = `${Math.max(
          visibleTop,
          Math.min(belowTop, visibleBottom - popover.offsetHeight)
        )}px`
        popover.dataset.vmdPosition = 'viewport'
      }
    } else {
      // Link/image popovers retain their established above-target placement.
      popover.style.top = `${aboveTop}px`
      popover.dataset.vmdPosition = 'above'
    }
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

function installPopoverTabOrder(elements: HTMLElement[]): void {
  elements.forEach((element, index) => {
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return
      event.preventDefault()
      event.stopPropagation()
      const offset = event.shiftKey ? elements.length - 1 : 1
      elements[(index + offset) % elements.length]?.focus()
    })
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
  deactivateAndFinishCustomPopover()
  activePopoverPosition = null
  popover.replaceChildren()
  popover.classList.remove(
    'vmd-url-popover--image',
    'vmd-wysiwyg-popover--empty',
    SOURCE_POPOVER_CLASS,
    POPOVER_POSITIONING_CLASS,
    PERSISTENT_POPOVER_CLASS
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
    }
    event.stopPropagation()
  })
  inputWrap.appendChild(input)
  popover.appendChild(inputWrap)
  const closeButton = addPopoverCloseButton(popover, inputWrap)
  installPopoverTabOrder([input, closeButton])

  positionAboveTarget(popover, target)
  popover.style.display = 'block'
  activateCustomPopover(popover, target)
  input.focus()
  input.select()
  return input
}

/** Opens serializer-owned source fields without exposing them in the document. */
export function showWysiwygSourcePopover({
  popover,
  target,
  fields,
  focusField,
  onChange,
  onFinish,
}: WysiwygSourcePopoverOptions): Readonly<Record<string, HTMLInputElement | HTMLTextAreaElement>> {
  finishDetailsTitlePopover()
  deactivateAndFinishCustomPopover()
  activePopoverPosition = null
  popover.replaceChildren()
  popover.classList.remove(
    'vmd-url-popover--image',
    'vmd-wysiwyg-popover--empty',
    DETAILS_TITLE_POPOVER_CLASS,
    POPOVER_POSITIONING_CLASS,
    PERSISTENT_POPOVER_CLASS
  )
  popover.classList.add('vmd-url-popover', SOURCE_POPOVER_CLASS)
  delete popover.dataset.vmdPosition

  const initialValues: Record<string, string> = {}
  const controls: Record<string, HTMLInputElement | HTMLTextAreaElement> = {}
  const error = document.createElement('div')
  error.className = 'vmd-source-popover__error'
  error.setAttribute('role', 'alert')
  error.hidden = true

  const currentValues = (): Readonly<Record<string, string>> => {
    const values: Record<string, string> = {}
    for (const field of fields) values[field.name] = controls[field.name]?.value ?? ''
    return values
  }
  const applyChange = (): void => {
    let message: string | null
    try {
      message = onChange(currentValues())
    } catch (reason) {
      message = reason instanceof Error && reason.message
        ? reason.message
        : 'Unable to update preview'
    }
    error.textContent = message || ''
    error.hidden = !message
    popover.classList.toggle('vmd-source-popover--invalid', !!message)
  }

  for (const field of fields) {
    initialValues[field.name] = field.value
    const row = document.createElement('label')
    row.className = 'vmd-source-popover__field'
    const label = document.createElement('span')
    label.className = 'vmd-source-popover__label'
    label.textContent = field.label
    const control = field.multiline
      ? document.createElement('textarea')
      : document.createElement('input')
    control.className = 'vditor-input vmd-source-popover__input'
    control.name = field.name
    control.value = field.value
    control.spellcheck = field.spellcheck ?? false
    control.setAttribute('aria-label', field.label)
    if (control instanceof HTMLTextAreaElement) {
      control.rows = 8
      control.wrap = 'off'
    } else {
      control.type = 'text'
    }
    control.addEventListener('input', (event) => {
      if (event instanceof InputEvent && event.isComposing) return
      applyChange()
    })
    control.addEventListener('compositionend', applyChange)
    control.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) {
        event.stopImmediatePropagation()
        return
      }
      if (
        event.key === 'Enter' &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeActiveWysiwygPopover(true)
        return
      }
      event.stopPropagation()
    })
    row.append(label, control)
    popover.appendChild(row)
    controls[field.name] = control
  }
  popover.appendChild(error)
  const closeButton = addPopoverCloseButton(popover, error)
  installPopoverTabOrder([...Object.values(controls), closeButton])

  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    const values = currentValues()
    const changed = fields.some(
      (field) => values[field.name] !== initialValues[field.name]
    )
    onFinish(values, changed)
  }

  positionAboveTarget(popover, target)
  popover.style.display = 'block'
  activateCustomPopover(popover, target, finish)
  const preferred = focusField ? controls[focusField] : undefined
  const first = preferred ?? controls[fields[0]?.name]
  const focusPreferredField = (): void => {
    if (!first?.isConnected || popover.style.display !== 'block') return
    first.focus({ preventScroll: true })
    if (first instanceof HTMLInputElement) first.select()
  }
  focusPreferredField()
  // Vditor's originating click may restore the editor selection after the
  // capture listener returns. Re-assert the requested field once that work ends.
  window.setTimeout(focusPreferredField, 0)
  return controls
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
  deactivateAndFinishCustomPopover()
  // Vditor reuses one popover element for every context.
  popover.classList.remove(
    'vmd-url-popover',
    'vmd-url-popover--image',
    DETAILS_TITLE_POPOVER_CLASS,
    SOURCE_POPOVER_CLASS,
    POPOVER_POSITIONING_CLASS,
    PERSISTENT_POPOVER_CLASS
  )
  delete popover.dataset.vmdPosition
  activePopoverPosition = null
  popover
    .querySelectorAll(
      '[data-type="up"], [data-type="down"], [data-type="remove"]'
    )
    .forEach((action) => action.remove())

  if (type === 'code-block') {
    // Language and source for ordinary and rich blocks live in our shared editor.
    popover.replaceChildren()
  } else if (type === 'heading') {
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
      const closeButton = addPopoverCloseButton(popover, copyButton)
      installPopoverTabOrder([urlInput, copyButton, closeButton])
      const target = getPopoverTarget(type)
      redirectHiddenLinkFocus(urlInput, target)
      positionAboveTarget(popover, target)
      activateCustomPopover(popover, target)
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
    const titleInput = fields[2]?.querySelector<HTMLInputElement>('input')
    if (fields[0] && urlInput) {
      const copyButton = addUrlCopyButton(popover, fields[0], urlInput)
      const closeButton = addPopoverCloseButton(popover, copyButton)
      installPopoverTabOrder(
        titleInput
          ? [urlInput, copyButton, closeButton, titleInput]
          : [urlInput, copyButton, closeButton]
      )
      const target = getPopoverTarget(type)
      positionAboveTarget(popover, target)
      activateCustomPopover(popover, target)
    }
    popover.classList.add('vmd-url-popover--image')
  }

  popover.classList.toggle(
    'vmd-wysiwyg-popover--empty',
    popover.childElementCount === 0 && popover.textContent.trim() === ''
  )
}
