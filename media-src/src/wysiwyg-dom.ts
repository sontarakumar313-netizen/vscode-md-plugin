const WYSIWYG_ROOT_SELECTOR = '.vditor-wysiwyg .vditor-reset'

type RootEventHandler<EventType extends Event> = (
  event: EventType,
  root: HTMLElement
) => boolean

export interface WysiwygDomFeature {
  refresh(root: HTMLElement): void
  beforeRebind?(): void
  onPointerDown?: RootEventHandler<PointerEvent>
  onClick?: RootEventHandler<MouseEvent>
  onKeydown?: RootEventHandler<KeyboardEvent>
  onKeyup?: RootEventHandler<KeyboardEvent>
  onSelectionChange?: RootEventHandler<Event>
  dispose?(): void
}

export interface WysiwygDomFeatureRegistration {
  requestRefresh(): void
}

const features: WysiwygDomFeature[] = []
const pendingFeatures = new Set<WysiwygDomFeature>()
let root: HTMLElement | null = null
let observer: MutationObserver | null = null
let refreshQueued = false
let globalListenersInstalled = false

export function getWysiwygRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(WYSIWYG_ROOT_SELECTOR)
}

function runRootHandlers<EventType extends Event>(
  event: EventType,
  handler: keyof Pick<
    WysiwygDomFeature,
    | 'onPointerDown'
    | 'onClick'
    | 'onKeydown'
    | 'onKeyup'
    | 'onSelectionChange'
  >
): void {
  const currentRoot = root
  if (!currentRoot) return
  for (const feature of features) {
    const callback = feature[handler] as
      | RootEventHandler<EventType>
      | undefined
    if (callback?.(event, currentRoot)) return
  }
}

function onRootPointerDown(event: PointerEvent): void {
  runRootHandlers(event, 'onPointerDown')
}

function onRootClick(event: MouseEvent): void {
  runRootHandlers(event, 'onClick')
}

function onRootKeydown(event: KeyboardEvent): void {
  runRootHandlers(event, 'onKeydown')
}

function onRootKeyup(event: KeyboardEvent): void {
  runRootHandlers(event, 'onKeyup')
}

function onSelectionChange(event: Event): void {
  runRootHandlers(event, 'onSelectionChange')
}

function installGlobalListeners(): void {
  if (globalListenersInstalled) return
  globalListenersInstalled = true
  document.addEventListener('selectionchange', onSelectionChange)
}

function removeGlobalListeners(): void {
  if (!globalListenersInstalled) return
  globalListenersInstalled = false
  document.removeEventListener('selectionchange', onSelectionChange)
}

function unbindRoot(): void {
  observer?.disconnect()
  observer = null
  if (!root) return
  root.removeEventListener('pointerdown', onRootPointerDown, true)
  root.removeEventListener('click', onRootClick, true)
  root.removeEventListener('keydown', onRootKeydown, true)
  root.removeEventListener('keyup', onRootKeyup, true)
  root = null
}

function flushRefresh(): void {
  refreshQueued = false
  const currentRoot = root
  if (!currentRoot) return
  const pending = Array.from(pendingFeatures)
  pendingFeatures.clear()
  for (const feature of pending) feature.refresh(currentRoot)
}

function queuePendingRefresh(): void {
  if (refreshQueued) return
  refreshQueued = true
  queueMicrotask(flushRefresh)
}

function requestAllRefreshes(): void {
  for (const feature of features) pendingFeatures.add(feature)
  queuePendingRefresh()
}

export function registerWysiwygDomFeature(
  feature: WysiwygDomFeature
): WysiwygDomFeatureRegistration {
  features.push(feature)
  installGlobalListeners()
  pendingFeatures.add(feature)
  queuePendingRefresh()
  return {
    requestRefresh(): void {
      pendingFeatures.add(feature)
      queuePendingRefresh()
    },
  }
}

/** Rebinds every WYSIWYG feature to the current Vditor root in one operation. */
export function rebindWysiwygDom(): void {
  for (const feature of features) feature.beforeRebind?.()
  const nextRoot = getWysiwygRoot()
  if (nextRoot === root) {
    requestAllRefreshes()
    return
  }

  unbindRoot()
  root = nextRoot
  if (!root) return
  root.addEventListener('pointerdown', onRootPointerDown, true)
  root.addEventListener('click', onRootClick, true)
  root.addEventListener('keydown', onRootKeydown, true)
  root.addEventListener('keyup', onRootKeyup, true)
  observer = new MutationObserver(requestAllRefreshes)
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  })
  requestAllRefreshes()
}

export function disposeWysiwygDom(): void {
  unbindRoot()
  removeGlobalListeners()
  refreshQueued = false
  pendingFeatures.clear()
  for (const feature of features.splice(0)) feature.dispose?.()
}
