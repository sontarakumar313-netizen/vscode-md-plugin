import {
  cancelPendingVditorWysiwygToolbar,
  commitVditorWysiwygDomEdit,
  getVditorInternals,
} from './vditor-adapter'

type SourcePopoverPlacement =
  | 'center'
  | 'code'
  | 'code-overlay'
  | 'html-block'
  | 'math-block'
  | 'target'
type PopoverPlacement = SourcePopoverPlacement | 'native-above'

let pendingPopoverTarget: HTMLElement | null = null
let activePopoverPosition: {
  popover: HTMLElement
  target: HTMLElement
  placement: PopoverPlacement
} | null = null
let activeCustomPopover: {
  popover: HTMLElement
  target: HTMLElement | null
  editorRoot: HTMLElement | null
  finish: (() => void) | null
} | null = null
let popoverPositionListenersInstalled = false
let popoverPositionQueued = false
let sourcePopoverResizeObserver: ResizeObserver | null = null
let observedSourcePositionTarget: HTMLElement | null = null
const POPOVER_POSITIONING_CLASS = 'vmd-url-popover--positioning'
const PERSISTENT_POPOVER_CLASS = 'vmd-url-popover--persistent'
const SOURCE_POPOVER_CLASS = 'vmd-source-popover'
const CODE_OVERLAY_POPOVER_CLASS = 'vmd-source-popover--code-overlay'
export const WYSIWYG_SOURCE_EDIT_BUTTON_CLASS = 'vmd-source-edit-button'

interface WysiwygSourcePopoverField {
  name: string
  label: string
  value: string
  multiline?: boolean
  spellcheck?: boolean
  closeOnEnter?: boolean
  acceptsTab?: boolean
}

interface WysiwygSourcePopoverOptions {
  popover: HTMLElement
  target: HTMLElement
  fields: WysiwygSourcePopoverField[]
  focusField?: string
  placement?: SourcePopoverPlacement
  onChange: (values: Readonly<Record<string, string>>) => string | null
  onFinish: (values: Readonly<Record<string, string>>, changed: boolean) => void
}

interface WysiwygSourceEditSessionOptions {
  target: HTMLElement
  fields: WysiwygSourcePopoverField[]
  focusField?: string
  placement?: SourcePopoverPlacement
  unavailableMessage: string
  resolveTarget?: () => HTMLElement | null
  isAvailable?: () => boolean
  onChange: (values: Readonly<Record<string, string>>) => string | null
  isSourceChanged: () => boolean
  beforeCommit?: () => void
  afterCommit?: () => void
  afterFinish?: () => void
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
    active.popover.classList.remove(
      POPOVER_POSITIONING_CLASS,
      CODE_OVERLAY_POPOVER_CLASS
    )
    if (activePopoverPosition?.popover === active.popover) {
      clearActivePopoverPosition()
    }
    if (pendingPopoverTarget === active.target) pendingPopoverTarget = null
  }
  if (active && restoreFocus) {
    restorePopoverFocus(active.target, active.editorRoot)
  }
}

export function disposeWysiwygPopover(): void {
  closeActiveWysiwygPopover()
  if (popoverPositionListenersInstalled) {
    document.removeEventListener('scroll', queueActivePopoverPosition, true)
    window.removeEventListener('resize', queueActivePopoverPosition)
    popoverPositionListenersInstalled = false
  }
  clearActivePopoverPosition()
  sourcePopoverResizeObserver = null
  pendingPopoverTarget = null
  popoverPositionQueued = false
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

function clearActivePopoverPosition(): void {
  const popover = activePopoverPosition?.popover
  popover?.classList.remove(POPOVER_POSITIONING_CLASS)
  popover?.style.removeProperty('--vmd-source-popover-available-height')
  popover?.style.removeProperty('--vmd-source-popover-available-width')
  popover?.style.removeProperty('width')
  popover?.style.removeProperty('max-width')
  popover?.style.removeProperty('height')
  popover?.style.removeProperty('max-height')
  popover?.style.removeProperty('position')
  popover?.style.removeProperty('clip-path')
  popover?.style.removeProperty('transform')
  sourcePopoverResizeObserver?.disconnect()
  observedSourcePositionTarget = null
  activePopoverPosition = null
}

function renderedMathPositionTarget(target: HTMLElement): HTMLElement | null {
  return target.querySelector<HTMLElement>(
    ':scope > .vditor-wysiwyg__preview .katex-display > .katex, ' +
      ':scope > .vditor-wysiwyg__preview mjx-container, ' +
      ':scope > .vditor-wysiwyg__preview .MathJax, ' +
      ':scope > .vditor-wysiwyg__preview .language-math > svg'
  ) || target.querySelector<HTMLElement>(
    ':scope > .vditor-wysiwyg__preview'
  )
}

function queueActivePopoverPosition(): void {
  if (popoverPositionQueued) return
  popoverPositionQueued = true
  // Vditor applies provisional coordinates after invoking its customization
  // callback. Run after that work and keep active source panels in the visible
  // editor area as their textarea or rendered target changes size.
  queueMicrotask(() => {
    popoverPositionQueued = false
    const active = activePopoverPosition
    if (!active) return
    const { popover, target, placement } = active
    const positionTarget = placement === 'code'
      ? target.querySelector<HTMLElement>(
        `.${WYSIWYG_SOURCE_EDIT_BUTTON_CLASS}`
      )
      : placement === 'code-overlay'
        ? target
        : placement === 'html-block'
        ? target.querySelector<HTMLElement>(
          ':scope > .vditor-wysiwyg__preview'
        )
        : placement === 'math-block'
          ? renderedMathPositionTarget(target)
          : target
    if (
      !popover.isConnected ||
      (placement !== 'center' &&
        (!target.isConnected || !positionTarget?.isConnected)) ||
      getComputedStyle(popover).display === 'none'
    ) {
      clearActivePopoverPosition()
      return
    }
    const editor = popover.parentElement
    if (!(editor instanceof HTMLElement)) {
      clearActivePopoverPosition()
      return
    }

    if (
      (placement === 'math-block' || placement === 'code-overlay') &&
      observedSourcePositionTarget !== positionTarget
    ) {
      if (observedSourcePositionTarget) {
        sourcePopoverResizeObserver?.unobserve(observedSourcePositionTarget)
      }
      sourcePopoverResizeObserver?.observe(positionTarget)
      observedSourcePositionTarget = positionTarget
    }

    const editorRect = editor.getBoundingClientRect()
    const targetRect = positionTarget.getBoundingClientRect()
    const gap = 6
    const toLocalLeft = (viewportLeft: number): number =>
      viewportLeft - editorRect.left + editor.scrollLeft
    const toLocalTop = (viewportTop: number): number =>
      viewportTop - editorRect.top + editor.scrollTop

    if (placement === 'native-above') {
      // Preserve the established Vditor link/image placement.
      popover.style.removeProperty('transform')
      const targetLeft = toLocalLeft(targetRect.left)
      const maxLeft = Math.max(
        0,
        editor.scrollLeft + editor.clientWidth - popover.offsetWidth
      )
      popover.style.left = `${Math.max(
        editor.scrollLeft,
        Math.min(targetLeft, maxLeft)
      )}px`
      popover.style.top = `${toLocalTop(
        targetRect.top - popover.offsetHeight - gap
      )}px`
      popover.dataset.vmdPosition = 'above'
    } else if (placement === 'code-overlay') {
      // Ordinary fenced code is edited in place. Keep the shared panel in the
      // same document coordinate space as the block so oversized editors move
      // with the block instead of being clamped to the viewport.
      popover.style.removeProperty('transform')
      popover.style.position = 'fixed'
      popover.style.width = `${targetRect.width}px`
      popover.style.maxWidth = 'none'
      popover.style.height = `${targetRect.height}px`
      popover.style.maxHeight = 'none'
      popover.style.left = `${targetRect.left}px`
      popover.style.top = `${targetRect.top}px`
      const root = target.closest<HTMLElement>('.vditor-reset')
      if (root) {
        const rootRect = root.getBoundingClientRect()
        const visibleLeft = Math.max(0, rootRect.left)
        const visibleTop = Math.max(0, rootRect.top)
        const visibleRight = Math.min(window.innerWidth, rootRect.right)
        const visibleBottom = Math.min(window.innerHeight, rootRect.bottom)
        popover.style.clipPath = `inset(${Math.max(
          0,
          visibleTop - targetRect.top
        )}px ${Math.max(
          0,
          targetRect.right - visibleRight
        )}px ${Math.max(
          0,
          targetRect.bottom - visibleBottom
        )}px ${Math.max(
          0,
          visibleLeft - targetRect.left
        )}px)`
      } else {
        popover.style.removeProperty('clip-path')
      }
      popover.dataset.vmdPosition = 'code-overlay'
    } else {
      const margin = 8
      const visibleLeft = editorRect.left + margin
      const visibleRight = editorRect.left + editor.clientWidth - margin
      const visibleTop = Math.max(editorRect.top, 0) + margin
      const editorBottom = editorRect.top + editor.clientHeight
      const visibleBottom = Math.min(editorBottom, window.innerHeight) - margin
      const availableHeight = Math.max(1, visibleBottom - visibleTop)
      const visibleWidth = Math.max(1, visibleRight - visibleLeft)
      const mathLeftSpace = Math.max(
        0,
        Math.min(visibleRight, targetRect.left) - gap - visibleLeft
      )
      const placeMathOnLeft =
        placement === 'math-block' &&
        mathLeftSpace >= Math.min(320, visibleWidth)
      const availableWidth = placement === 'code'
        ? Math.max(1, targetRect.right - visibleLeft)
        : placement === 'html-block'
          ? Math.max(1, visibleRight - Math.max(visibleLeft, targetRect.left))
          : placeMathOnLeft
            ? mathLeftSpace
            : visibleWidth
      popover.style.setProperty(
        '--vmd-source-popover-available-height',
        `${availableHeight}px`
      )
      popover.style.setProperty(
        '--vmd-source-popover-available-width',
        `${availableWidth}px`
      )

      const clamp = (value: number, minimum: number, maximum: number): number =>
        Math.max(minimum, Math.min(value, Math.max(minimum, maximum)))
      let popoverRect = popover.getBoundingClientRect()
      let popoverWidth = popoverRect.width
      let popoverHeight = popoverRect.height
      let viewportLeft: number
      let viewportTop: number

      if (placement === 'center') {
        viewportLeft = (visibleLeft + visibleRight) / 2
        viewportTop = (visibleTop + visibleBottom) / 2
        popover.style.transform = 'translate(-50%, -50%)'
        popover.dataset.vmdPosition = 'center'
      } else if (placement === 'code') {
        popover.style.removeProperty('transform')
        const belowTop = targetRect.bottom + gap
        const aboveBottom = targetRect.top - gap
        const belowSpace = Math.max(0, visibleBottom - belowTop)
        const aboveSpace = Math.max(0, aboveBottom - visibleTop)
        const below = popoverHeight <= belowSpace
        if (!below && popoverHeight > aboveSpace) {
          popover.style.setProperty(
            '--vmd-source-popover-available-height',
            `${Math.max(1, aboveSpace)}px`
          )
          popoverRect = popover.getBoundingClientRect()
          popoverWidth = popoverRect.width
          popoverHeight = popoverRect.height
        }
        viewportLeft = clamp(
          targetRect.right - popoverWidth,
          visibleLeft,
          visibleRight - popoverWidth
        )
        viewportTop = below
          ? belowTop
          : aboveBottom - popoverHeight
        popover.dataset.vmdPosition = below ? 'below' : 'above'
      } else if (placement === 'html-block') {
        popover.style.removeProperty('transform')
        const aboveBottom = targetRect.top - gap
        const belowTop = targetRect.bottom + gap
        const aboveSpace = Math.max(0, aboveBottom - visibleTop)
        const belowSpace = Math.max(0, visibleBottom - belowTop)
        // Raw HTML commonly appears at the start of README files. Always
        // forcing its editor above the block reduced the panel to a thin,
        // awkward scroll area there even though most of the viewport was free
        // below it. Prefer the larger side; ties retain the established
        // above-target placement.
        const above = aboveSpace >= belowSpace
        const chosenSpace = above ? aboveSpace : belowSpace
        if (popoverHeight > chosenSpace) {
          popover.style.setProperty(
            '--vmd-source-popover-available-height',
            `${Math.max(1, chosenSpace)}px`
          )
          popoverRect = popover.getBoundingClientRect()
          popoverWidth = popoverRect.width
          popoverHeight = popoverRect.height
        }
        viewportLeft = clamp(
          targetRect.left,
          visibleLeft,
          visibleRight - popoverWidth
        )
        viewportTop = above
          ? aboveBottom - popoverHeight
          : belowTop
        popover.dataset.vmdPosition = above ? 'above' : 'below'
      } else if (placement === 'math-block') {
        popover.style.removeProperty('transform')
        if (placeMathOnLeft) {
          viewportLeft = clamp(
            targetRect.left - gap - popoverWidth,
            visibleLeft,
            visibleRight - popoverWidth
          )
          viewportTop = clamp(
            targetRect.top + targetRect.height / 2,
            visibleTop,
            visibleBottom - popoverHeight
          )
          popover.dataset.vmdPosition = 'left'
        } else {
          const aboveBottom = targetRect.top - gap
          const belowTop = targetRect.bottom + gap
          const aboveSpace = Math.max(0, aboveBottom - visibleTop)
          const belowSpace = Math.max(0, visibleBottom - belowTop)
          const above = popoverHeight <= aboveSpace ||
            (popoverHeight > belowSpace && aboveSpace >= belowSpace)
          const chosenSpace = above ? aboveSpace : belowSpace
          if (popoverHeight > chosenSpace) {
            popover.style.setProperty(
              '--vmd-source-popover-available-height',
              `${Math.max(1, chosenSpace)}px`
            )
            popoverRect = popover.getBoundingClientRect()
            popoverWidth = popoverRect.width
            popoverHeight = popoverRect.height
          }
          viewportLeft = clamp(
            targetRect.left + targetRect.width / 2 - popoverWidth / 2,
            visibleLeft,
            visibleRight - popoverWidth
          )
          viewportTop = clamp(
            above ? aboveBottom - popoverHeight : belowTop,
            visibleTop,
            visibleBottom - popoverHeight
          )
          popover.dataset.vmdPosition = above ? 'above' : 'below'
        }
      } else {
        popover.style.removeProperty('transform')
        viewportLeft = clamp(
          targetRect.left,
          visibleLeft,
          visibleRight - popoverWidth
        )
        const aboveTop = targetRect.top - popoverHeight - gap
        const belowTop = targetRect.bottom + gap
        if (aboveTop >= visibleTop) {
          viewportTop = aboveTop
          popover.dataset.vmdPosition = 'above'
        } else if (belowTop + popoverHeight <= visibleBottom) {
          viewportTop = belowTop
          popover.dataset.vmdPosition = 'below'
        } else {
          viewportTop = clamp(
            belowTop,
            visibleTop,
            visibleBottom - popoverHeight
          )
          popover.dataset.vmdPosition = 'viewport'
        }
      }

      popover.style.left = placement === 'center'
        ? `calc(50% + ${editor.scrollLeft}px)`
        : `${toLocalLeft(viewportLeft)}px`
      popover.style.top = `${toLocalTop(viewportTop)}px`
    }
    popover.classList.remove(POPOVER_POSITIONING_CLASS)
    if (pendingPopoverTarget === target) pendingPopoverTarget = null
  })
}

function installPopoverPositionListeners(): void {
  if (popoverPositionListenersInstalled) return
  popoverPositionListenersInstalled = true
  // Vditor rewrites the shared panel's top position while the editor scrolls.
  // Re-apply the selected placement after its handler.
  document.addEventListener('scroll', queueActivePopoverPosition, true)
  window.addEventListener('resize', queueActivePopoverPosition)
}

function positionPopover(
  popover: HTMLElement,
  target: HTMLElement | null,
  placement: PopoverPlacement
): void {
  if (!target || !target.isConnected) return
  clearActivePopoverPosition()
  popover.classList.add(POPOVER_POSITIONING_CLASS)
  activePopoverPosition = { popover, target, placement }
  if (placement !== 'native-above') {
    sourcePopoverResizeObserver ??= new ResizeObserver(
      queueActivePopoverPosition
    )
    sourcePopoverResizeObserver.observe(popover)
    popover
      .querySelectorAll<HTMLTextAreaElement>('textarea')
      .forEach((textarea) => sourcePopoverResizeObserver?.observe(textarea))
    if (popover.parentElement instanceof HTMLElement) {
      sourcePopoverResizeObserver.observe(popover.parentElement)
    }
  }
  installPopoverPositionListeners()
  queueActivePopoverPosition()
  if (placement !== 'native-above') {
    window.requestAnimationFrame(queueActivePopoverPosition)
  }
}

export function retargetActiveWysiwygCodeOverlay(
  previousTarget: HTMLElement,
  nextTarget: HTMLElement
): boolean {
  const active = activeCustomPopover
  if (
    !active ||
    active.target !== previousTarget ||
    !nextTarget.isConnected ||
    !active.popover.classList.contains(CODE_OVERLAY_POPOVER_CLASS)
  ) {
    return false
  }

  active.target = nextTarget
  if (pendingPopoverTarget === previousTarget) {
    pendingPopoverTarget = nextTarget
  }

  if (activePopoverPosition?.popover === active.popover) {
    if (observedSourcePositionTarget) {
      sourcePopoverResizeObserver?.unobserve(observedSourcePositionTarget)
      observedSourcePositionTarget = null
    }
    activePopoverPosition.target = nextTarget
    queueActivePopoverPosition()
  } else {
    positionPopover(active.popover, nextTarget, 'code-overlay')
  }
  return true
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

/** Opens serializer-owned source fields without exposing them in the document. */
function showWysiwygSourcePopover({
  popover,
  target,
  fields,
  focusField,
  placement = fields.some((field) => field.multiline) ? 'center' : 'target',
  onChange,
  onFinish,
}: WysiwygSourcePopoverOptions): void {
  deactivateAndFinishCustomPopover()
  clearActivePopoverPosition()
  popover.replaceChildren()
  popover.classList.remove(
    'vmd-url-popover--image',
    'vmd-wysiwyg-popover--empty',
    CODE_OVERLAY_POPOVER_CLASS,
    POPOVER_POSITIONING_CLASS,
    PERSISTENT_POPOVER_CLASS
  )
  popover.classList.add('vmd-url-popover', SOURCE_POPOVER_CLASS)
  if (placement === 'code-overlay') {
    popover.classList.add(CODE_OVERLAY_POPOVER_CLASS)
  }
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
    queueActivePopoverPosition()
  }

  for (const field of fields) {
    initialValues[field.name] = field.value
    const row = document.createElement('label')
    row.className = 'vmd-source-popover__field'
    row.dataset.vmdSourceField = field.name
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
        event.key === 'Tab' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        field.acceptsTab &&
        control instanceof HTMLTextAreaElement
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
        control.setRangeText(
          '\t',
          control.selectionStart,
          control.selectionEnd,
          'end'
        )
        applyChange()
        return
      }
      if (
        event.key === 'Enter' &&
        (field.closeOnEnter ||
          ((event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            !event.shiftKey))
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

  positionPopover(popover, target, placement)
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
  window.setTimeout(() => {
    focusPreferredField()
    queueActivePopoverPosition()
  }, 0)
}

export function getSharedWysiwygPopover(): HTMLElement | null {
  const popover = getVditorInternals()?.wysiwyg?.popover
  return popover instanceof HTMLElement ? popover : null
}

export function hideWysiwygSerializerSource(source: HTMLElement): void {
  source.style.setProperty('display', 'none', 'important')
}

export function createWysiwygSourceEditButton(
  label: string,
  className = WYSIWYG_SOURCE_EDIT_BUTTON_CLASS
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.setAttribute('contenteditable', 'false')
  button.setAttribute('data-render', '1')
  button.setAttribute('aria-label', label)
  button.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.7 1.8a1.4 1.4 0 0 1 2 2l-8.4 8.4-3 .6.6-3 8.8-8z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>'
  return button
}

/** Runs one serializer-owned source editing session and commits it once. */
export function openWysiwygSourceEditSession({
  target,
  fields,
  focusField,
  placement,
  unavailableMessage,
  resolveTarget,
  isAvailable,
  onChange,
  isSourceChanged,
  beforeCommit,
  afterCommit,
  afterFinish,
}: WysiwygSourceEditSessionOptions): boolean {
  const popover = getSharedWysiwygPopover()
  const internal = getVditorInternals()
  if (!popover || !internal || internal.currentMode !== 'wysiwyg') return false

  showWysiwygSourcePopover({
    popover,
    target,
    fields,
    focusField,
    placement,
    onChange: (values) => {
      const currentTarget = resolveTarget ? resolveTarget() : target
      if (
        !currentTarget?.isConnected ||
        (isAvailable && !isAvailable())
      ) {
        return unavailableMessage
      }
      return onChange(values)
    },
    onFinish: (_values, changed) => {
      try {
        const currentTarget = resolveTarget ? resolveTarget() : target
        if (
          !changed ||
          !currentTarget?.isConnected ||
          (isAvailable && !isAvailable()) ||
          !isSourceChanged()
        ) {
          return
        }
        beforeCommit?.()
        commitVditorWysiwygDomEdit(internal)
        afterCommit?.()
      } finally {
        afterFinish?.()
      }
    },
  })
  return true
}

/**
 * Removes unwanted native controls from Vditor's WYSIWYG popover. Table
 * actions are provided by the shared right-click menu instead.
 */
export function customizeWysiwygPopover(
  type: string,
  popover: HTMLElement
): void {
  deactivateAndFinishCustomPopover()
  // Vditor reuses one popover element for every context.
  popover.classList.remove(
    'vmd-url-popover',
    'vmd-url-popover--image',
    SOURCE_POPOVER_CLASS,
    CODE_OVERLAY_POPOVER_CLASS,
    POPOVER_POSITIONING_CLASS,
    PERSISTENT_POPOVER_CLASS
  )
  delete popover.dataset.vmdPosition
  clearActivePopoverPosition()
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
      positionPopover(popover, target, 'native-above')
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
      positionPopover(popover, target, 'native-above')
      activateCustomPopover(popover, target)
    }
    popover.classList.add('vmd-url-popover--image')
  }

  popover.classList.toggle(
    'vmd-wysiwyg-popover--empty',
    popover.childElementCount === 0 && popover.textContent.trim() === ''
  )
}
