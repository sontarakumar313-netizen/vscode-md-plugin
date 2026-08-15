import {
  activateFloatingPanel,
  deactivateFloatingPanel,
} from './floating-panel'
import type { FloatingPanelCloseReason } from './floating-panel'

interface MenuOpenOptions {
  safeTargets?: readonly HTMLElement[]
  onDismiss: (reason: FloatingPanelCloseReason) => void
}

interface MenuControllerOptions<Item extends HTMLElement> {
  itemSelector: string
  menu: HTMLElement
  onActivate: (item: Item) => void
}

export interface MenuController {
  close(): void
  dispose(): void
  open(options: MenuOpenOptions): void
}

const controllers = new Set<MenuController>()

function eventTargetElement(event: Event): Element | null {
  return event.target instanceof Element ? event.target : null
}

function isEditableControl(target: Element | null): boolean {
  return !!target?.closest(
    'input, textarea, select, [contenteditable="true"]'
  )
}

/**
 * Owns the common interaction contract for one floating menu while leaving
 * menu contents, positioning, state, and business actions to its caller.
 */
export function createMenuController<Item extends HTMLElement>({
  itemSelector,
  menu,
  onActivate,
}: MenuControllerOptions<Item>): MenuController {
  let activeOptions: MenuOpenOptions | null = null
  let disposed = false

  const availableItems = (): Item[] =>
    Array.from(menu.querySelectorAll<Item>(itemSelector)).filter((item) => {
      if (item.matches(':disabled, [aria-disabled="true"]')) return false
      const style = window.getComputedStyle(item)
      return style.display !== 'none' && style.visibility !== 'hidden'
    })

  const itemFromTarget = (target: Element | null): Item | null => {
    const item = target?.closest<Item>(itemSelector) || null
    return item && menu.contains(item) ? item : null
  }

  const close = (): void => {
    activeOptions = null
    deactivateFloatingPanel(menu)
  }

  const dismiss = (reason: FloatingPanelCloseReason): void => {
    const current = activeOptions
    if (!current) return
    activeOptions = null
    deactivateFloatingPanel(menu)
    current.onDismiss(reason)
  }

  const preserveSelection = (event: Event): void => {
    event.stopPropagation()
    if (!isEditableControl(eventTargetElement(event))) {
      event.preventDefault()
    }
  }

  const handleClick = (event: MouseEvent): void => {
    event.stopPropagation()
    if (!activeOptions) return
    const item = itemFromTarget(eventTargetElement(event))
    if (!item || !availableItems().includes(item)) return
    event.preventDefault()
    onActivate(item)
  }

  const handleKeydown = (event: KeyboardEvent): void => {
    if (!activeOptions || event.isComposing || event.keyCode === 229) return
    const target = eventTargetElement(event)
    if (menu.contains(target) && isEditableControl(target)) return

    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      dismiss('escape')
      return
    }

    const items = availableItems()
    if (items.length === 0) return
    const active = document.activeElement instanceof HTMLElement
      ? document.activeElement.closest<Item>(itemSelector)
      : null
    const activeIndex = active ? items.indexOf(active) : -1
    let nextIndex = -1

    if (event.key === 'ArrowDown') {
      nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % items.length
    } else if (event.key === 'ArrowUp') {
      nextIndex = activeIndex <= 0 ? items.length - 1 : activeIndex - 1
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = items.length - 1
    } else if (
      (event.key === 'Enter' || event.key === ' ') &&
      activeIndex >= 0
    ) {
      event.preventDefault()
      event.stopPropagation()
      onActivate(items[activeIndex])
      return
    }

    if (nextIndex < 0) return
    event.preventDefault()
    event.stopPropagation()
    const nextItem = items[nextIndex]
    nextItem?.focus({ preventScroll: true })
    nextItem?.scrollIntoView({ block: 'nearest' })
  }

  menu.addEventListener('pointerdown', preserveSelection)
  menu.addEventListener('mousedown', preserveSelection)
  menu.addEventListener('click', handleClick)
  document.addEventListener('keydown', handleKeydown, true)

  const controller: MenuController = {
    close,
    dispose(): void {
      if (disposed) return
      disposed = true
      close()
      menu.removeEventListener('pointerdown', preserveSelection)
      menu.removeEventListener('mousedown', preserveSelection)
      menu.removeEventListener('click', handleClick)
      document.removeEventListener('keydown', handleKeydown, true)
      controllers.delete(controller)
    },
    open(options: MenuOpenOptions): void {
      if (disposed) return
      activeOptions = options
      activateFloatingPanel({
        panel: menu,
        safeTargets: options.safeTargets,
        onDismiss: dismiss,
      })
    },
  }
  controllers.add(controller)
  return controller
}

export function disposeMenuControllers(): void {
  Array.from(controllers).forEach((controller) => controller.dispose())
}
