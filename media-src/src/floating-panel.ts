export type FloatingPanelCloseReason =
  | 'blur'
  | 'escape'
  | 'outside'
  | 'replace'
  | 'resize'
  | 'scroll'

interface ActiveFloatingPanel {
  panel: HTMLElement
  safeTargets: readonly HTMLElement[]
  onDismiss: (reason: FloatingPanelCloseReason) => void
}

interface FloatingPanelOptions {
  panel: HTMLElement
  safeTargets?: readonly HTMLElement[]
  onDismiss: (reason: FloatingPanelCloseReason) => void
}

let activePanel: ActiveFloatingPanel | null = null
let listenersInstalled = false

function dismissActivePanel(reason: FloatingPanelCloseReason): void {
  const active = activePanel
  if (!active) return
  activePanel = null
  active.onDismiss(reason)
}

function onDocumentPointerDown(event: PointerEvent): void {
  const active = activePanel
  const target = event.target
  if (!active || !(target instanceof Node)) return
  if (
    active.panel.contains(target) ||
    active.safeTargets.some((safeTarget) => safeTarget.contains(target))
  ) {
    return
  }
  dismissActivePanel('outside')
}

function onDocumentScroll(): void {
  dismissActivePanel('scroll')
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') dismissActivePanel('escape')
}

function onWindowResize(): void {
  dismissActivePanel('resize')
}

function onWindowBlur(): void {
  dismissActivePanel('blur')
}

function installListeners(): void {
  if (listenersInstalled) return
  listenersInstalled = true
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('scroll', onDocumentScroll, true)
  document.addEventListener('keydown', onDocumentKeydown)
  window.addEventListener('resize', onWindowResize)
  window.addEventListener('blur', onWindowBlur)
}

export function activateFloatingPanel({
  panel,
  safeTargets = [],
  onDismiss,
}: FloatingPanelOptions): void {
  if (activePanel?.panel !== panel) dismissActivePanel('replace')
  activePanel = { panel, safeTargets, onDismiss }
  installListeners()
}

/** Clears ownership without invoking the panel's dismissal callback. */
export function deactivateFloatingPanel(panel: HTMLElement): void {
  if (activePanel?.panel === panel) activePanel = null
}

export function positionFloatingPanelAtPoint(
  panel: HTMLElement,
  clientX: number,
  clientY: number
): void {
  const margin = 8
  panel.style.display = 'block'
  panel.style.visibility = 'hidden'
  panel.style.left = '0'
  panel.style.top = '0'

  const maxLeft = Math.max(margin, window.innerWidth - panel.offsetWidth - margin)
  const maxTop = Math.max(margin, window.innerHeight - panel.offsetHeight - margin)
  panel.style.left = `${Math.min(Math.max(clientX, margin), maxLeft)}px`
  panel.style.top = `${Math.min(Math.max(clientY, margin), maxTop)}px`
  panel.style.visibility = 'visible'
}

export function positionFloatingPanelAtTarget(
  panel: HTMLElement,
  target: HTMLElement
): void {
  const margin = 8
  const gap = 4
  panel.style.display = 'block'
  panel.style.visibility = 'hidden'
  panel.style.left = '0'
  panel.style.top = '0'

  const targetRect = target.getBoundingClientRect()
  const maxLeft = Math.max(margin, window.innerWidth - panel.offsetWidth - margin)
  const left = Math.min(Math.max(targetRect.left, margin), maxLeft)
  const below = targetRect.bottom + gap
  const above = targetRect.top - panel.offsetHeight - gap
  const maxTop = Math.max(margin, window.innerHeight - panel.offsetHeight - margin)
  const top = below <= maxTop || above < margin ? Math.min(below, maxTop) : above
  panel.style.left = `${left}px`
  panel.style.top = `${Math.max(margin, top)}px`
  panel.style.visibility = 'visible'
}

export function disposeFloatingPanels(): void {
  dismissActivePanel('blur')
  if (!listenersInstalled) return
  listenersInstalled = false
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  document.removeEventListener('scroll', onDocumentScroll, true)
  document.removeEventListener('keydown', onDocumentKeydown)
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('blur', onWindowBlur)
}
