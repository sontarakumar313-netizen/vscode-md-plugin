import { t } from './lang'
import { ALERT_TYPES } from './quote-format'
import type { AlertType } from './quote-format'
import {
  commitVditorWysiwygDomEdit,
  getVditorInternals,
} from './vditor-adapter'

const ALERT_CLASS = 'vmd-alert'
const ALERT_MARKER_CLASS = 'vmd-alert-marker'
const ALERT_TITLE_CLASS = 'vmd-alert-title'
const ALERT_MENU_ID = 'vmd-alert-type-menu'
const ALERT_MENU_CURRENT_CLASS = 'vmd-alert-type-menu__current'
const ALERT_TYPE_CLASSES = ALERT_TYPES.map(
  (type) => `${ALERT_CLASS}--${type.toLowerCase()}`
)
const ALERT_MARKER_PATTERN = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/
const ALERT_MARKER_TYPE_PATTERN = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/

const ALERT_ICONS: Record<AlertType, string> = {
  NOTE: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M8 7v4M8 4.5h.01"/></svg>',
  TIP: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.4 11h5.2M6 13h4M8 2.2a4.2 4.2 0 0 0-2.5 7.6c.5.4.8.8.9 1.2h3.2c.1-.4.4-.8.9-1.2A4.2 4.2 0 0 0 8 2.2Z"/></svg>',
  IMPORTANT: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.7 14 5v6l-6 3.3L2 11V5l6-3.3ZM8 5v3.5M8 11h.01"/></svg>',
  WARNING: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 14.3 14H1.7L8 1.8ZM8 6v3.5M8 12h.01"/></svg>',
  CAUTION: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 1.7-3.3 3.3v6L5 14.3h6l3.3-3.3V5L11 1.7H5ZM8 5v3.5M8 11h.01"/></svg>',
}

interface AlertMenuState {
  blockquote: HTMLElement
  marker: HTMLElement
  title: HTMLElement
  type: AlertType
}

function getWysiwygRoot(): HTMLElement | null {
  return document.querySelector('.vditor-wysiwyg .vditor-reset')
}

function alertType(value: unknown): AlertType | null {
  if (typeof value !== 'string') return null
  return ALERT_TYPES.find((type) => type === value) || null
}

function markerType(marker: HTMLElement): AlertType | null {
  const match = ALERT_MARKER_PATTERN.exec(marker.textContent || '')
  return alertType(match?.[1])
}

function findOrCreateMarker(paragraph: HTMLElement): {
  marker: HTMLElement
  type: AlertType
} | null {
  const existing = paragraph.querySelector<HTMLElement>(
    `:scope > .${ALERT_MARKER_CLASS}`
  )
  const existingType = existing ? markerType(existing) : null
  if (existing && existingType) return { marker: existing, type: existingType }

  const first = paragraph.firstChild
  if (!(first instanceof Text)) return null
  const match = ALERT_MARKER_PATTERN.exec(first.data)
  const type = alertType(match?.[1])
  if (!match || !type) return null

  const marker = document.createElement('span')
  marker.className = ALERT_MARKER_CLASS
  marker.setAttribute('contenteditable', 'false')
  marker.textContent = match[0]
  first.deleteData(0, match[0].length)
  paragraph.insertBefore(marker, first)
  return { marker, type }
}

function clearAlert(blockquote: HTMLElement): void {
  blockquote.classList.remove(ALERT_CLASS, ...ALERT_TYPE_CLASSES)
  blockquote.removeAttribute('data-vmd-alert')
  blockquote
    .querySelector(`:scope > .${ALERT_TITLE_CLASS}`)
    ?.remove()
}

function decorateAlert(blockquote: HTMLElement): void {
  const paragraph = blockquote.querySelector<HTMLElement>(':scope > p:first-of-type')
  const alert = paragraph ? findOrCreateMarker(paragraph) : null
  if (!alert) {
    clearAlert(blockquote)
    return
  }

  blockquote.classList.remove(...ALERT_TYPE_CLASSES)
  blockquote.classList.add(ALERT_CLASS, `${ALERT_CLASS}--${alert.type.toLowerCase()}`)
  blockquote.setAttribute('data-vmd-alert', alert.type)

  let title = blockquote.querySelector<HTMLElement>(
    `:scope > .${ALERT_TITLE_CLASS}`
  )
  if (!title) {
    const button = document.createElement('button')
    button.type = 'button'
    title = button
    title.className = `vditor-wysiwyg__preview ${ALERT_TITLE_CLASS}`
    title.setAttribute('data-render', '1')
    title.setAttribute('contenteditable', 'false')
    title.setAttribute('aria-haspopup', 'menu')
    title.setAttribute('aria-expanded', 'false')
    blockquote.insertBefore(title, paragraph)
  }
  title.setAttribute(
    'aria-label',
    `${t('changeAlertType')}: ${alert.type}`
  )
  if (title.getAttribute('data-vmd-alert-title') !== alert.type) {
    title.setAttribute('data-vmd-alert-title', alert.type)
    title.innerHTML = `${ALERT_ICONS[alert.type]}<span>${alert.type}</span>`
  }
}

function createAlertTypeMenu(): HTMLDivElement {
  const menu = document.createElement('div')
  menu.id = ALERT_MENU_ID
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', t('changeAlertType'))

  for (const type of ALERT_TYPES) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.alertType = type
    button.setAttribute('role', 'menuitemradio')
    button.setAttribute('aria-checked', 'false')
    button.setAttribute('aria-label', type)
    button.innerHTML = `<span class="vmd-alert-type-menu__icon">${ALERT_ICONS[type]}</span><span>${type}</span>`
    menu.appendChild(button)
  }

  document.body.appendChild(menu)
  return menu
}

function positionAlertTypeMenu(menu: HTMLElement, target: HTMLElement): void {
  const margin = 8
  const gap = 4
  menu.style.display = 'block'
  menu.style.visibility = 'hidden'
  menu.style.left = '0'
  menu.style.top = '0'

  const targetRect = target.getBoundingClientRect()
  const maxLeft = Math.max(margin, window.innerWidth - menu.offsetWidth - margin)
  const left = Math.min(Math.max(targetRect.left, margin), maxLeft)
  const below = targetRect.bottom + gap
  const above = targetRect.top - menu.offsetHeight - gap
  const maxTop = Math.max(margin, window.innerHeight - menu.offsetHeight - margin)
  const top = below <= maxTop || above < margin ? Math.min(below, maxTop) : above

  menu.style.left = `${left}px`
  menu.style.top = `${Math.max(margin, top)}px`
  menu.style.visibility = 'visible'
}

/** Adds GitHub Alert presentation and an in-place type picker. */
export function initWysiwygAlerts() {
  const menu = createAlertTypeMenu()
  let state: AlertMenuState | null = null
  let root: HTMLElement | null = null
  let boundRoot: HTMLElement | null = null
  let observer: MutationObserver | null = null
  const queuedRoots = new WeakSet<HTMLElement>()

  function hideMenu(): void {
    state?.title.setAttribute('aria-expanded', 'false')
    state = null
    menu.style.display = 'none'
    menu.style.visibility = ''
  }

  function setCurrentType(type: AlertType): void {
    menu.querySelectorAll<HTMLButtonElement>('button[data-alert-type]').forEach(
      (button) => {
        const current = button.dataset.alertType === type
        button.classList.toggle(ALERT_MENU_CURRENT_CLASS, current)
        button.setAttribute('aria-checked', String(current))
      }
    )
  }

  function showMenu(nextState: AlertMenuState): void {
    if (
      state?.title === nextState.title &&
      menu.style.display === 'block'
    ) {
      hideMenu()
      return
    }

    hideMenu()
    state = nextState
    state.title.setAttribute('aria-expanded', 'true')
    setCurrentType(state.type)
    positionAlertTypeMenu(menu, state.title)
  }

  function refresh(targetRoot: HTMLElement): void {
    queuedRoots.delete(targetRoot)
    targetRoot.querySelectorAll<HTMLElement>('blockquote').forEach(decorateAlert)

    if (!state) return
    const type = state.marker.isConnected ? markerType(state.marker) : null
    if (!state.title.isConnected || !state.blockquote.isConnected || !type) {
      hideMenu()
      return
    }
    state.type = type
    setCurrentType(type)
  }

  function queueRefresh(targetRoot: HTMLElement): void {
    if (queuedRoots.has(targetRoot)) return
    queuedRoots.add(targetRoot)
    queueMicrotask(() => refresh(targetRoot))
  }

  function titleTarget(event: Event): AlertMenuState | null {
    const target = event.target instanceof Element ? event.target : null
    const title = target?.closest<HTMLElement>(`.${ALERT_TITLE_CLASS}`) || null
    const blockquote = title?.closest<HTMLElement>('blockquote') || null
    const paragraph = blockquote?.querySelector<HTMLElement>(':scope > p:first-of-type') || null
    const marker = paragraph?.querySelector<HTMLElement>(
      `:scope > .${ALERT_MARKER_CLASS}`
    ) || null
    const type = marker ? markerType(marker) : null
    if (
      !root ||
      !title ||
      !blockquote ||
      !marker ||
      !type ||
      !root.contains(blockquote)
    ) {
      return null
    }
    return { blockquote, marker, title, type }
  }

  function onRootPointerDown(event: PointerEvent): void {
    if (!titleTarget(event)) return
    // Keep the editable body selection while the non-editable title is clicked.
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function onRootClick(event: MouseEvent): void {
    const nextState = titleTarget(event)
    if (!nextState) return
    event.preventDefault()
    event.stopImmediatePropagation()
    showMenu(nextState)
  }

  function applyType(type: AlertType): void {
    const current = state
    hideMenu()
    const internal = getVditorInternals()
    if (
      !current ||
      !internal ||
      internal.currentMode !== 'wysiwyg' ||
      !current.blockquote.isConnected ||
      !current.marker.isConnected ||
      !current.blockquote.contains(current.marker)
    ) {
      return
    }

    const previousType = markerType(current.marker)
    if (!previousType || previousType === type) return
    const marker = current.marker.textContent || ''
    const replacement = marker.replace(
      ALERT_MARKER_TYPE_PATTERN,
      `[!${type}]`
    )
    if (replacement === marker) return

    current.marker.textContent = replacement
    decorateAlert(current.blockquote)
    commitVditorWysiwygDomEdit(internal)
  }

  function unbindRoot(): void {
    observer?.disconnect()
    observer = null
    if (!boundRoot) return
    boundRoot.removeEventListener('pointerdown', onRootPointerDown, true)
    boundRoot.removeEventListener('click', onRootClick, true)
    boundRoot = null
  }

  function rebind(): void {
    hideMenu()
    const nextRoot = getWysiwygRoot()
    if (nextRoot === root && boundRoot === nextRoot) {
      if (root) queueRefresh(root)
      return
    }

    unbindRoot()
    root = nextRoot
    if (!root) return

    const observedRoot = root
    observedRoot.addEventListener('pointerdown', onRootPointerDown, true)
    observedRoot.addEventListener('click', onRootClick, true)
    boundRoot = observedRoot
    observer = new MutationObserver(() => queueRefresh(observedRoot))
    observer.observe(observedRoot, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    queueRefresh(observedRoot)
  }

  menu.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  menu.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest<HTMLButtonElement>(
      'button[data-alert-type]'
    )
    const type = alertType(button?.dataset.alertType)
    if (type) applyType(type)
  })
  menu.addEventListener('keydown', (event) => {
    const buttons = Array.from(
      menu.querySelectorAll<HTMLButtonElement>('button[data-alert-type]')
    )
    const activeIndex = document.activeElement instanceof HTMLButtonElement
      ? buttons.indexOf(document.activeElement)
      : -1
    let nextIndex = -1
    if (event.key === 'ArrowDown') {
      nextIndex = (Math.max(0, activeIndex) + 1) % buttons.length
    } else if (event.key === 'ArrowUp') {
      nextIndex = (activeIndex <= 0 ? buttons.length : activeIndex) - 1
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = buttons.length - 1
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      hideMenu()
      return
    }
    if (nextIndex < 0) return
    event.preventDefault()
    event.stopPropagation()
    buttons[nextIndex]?.focus()
  })

  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target instanceof Element ? event.target : null
      if (
        target?.closest(`#${ALERT_MENU_ID}`) ||
        target?.closest(`.${ALERT_TITLE_CLASS}`)
      ) {
        return
      }
      hideMenu()
    },
    true
  )
  document.addEventListener('scroll', hideMenu, true)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.style.display === 'block') hideMenu()
  })
  window.addEventListener('resize', hideMenu)
  window.addEventListener('blur', hideMenu)

  rebind()
  return { rebind }
}
