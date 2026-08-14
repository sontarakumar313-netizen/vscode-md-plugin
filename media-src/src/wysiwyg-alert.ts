import { t } from './lang'
import { ALERT_TYPES } from './quote-format'
import type { AlertType } from './quote-format'
import {
  ALERT_CLASS,
  ALERT_ICONS,
  ALERT_MARKER_CLASS,
  ALERT_MARKER_PATTERN,
  ALERT_MARKER_TYPE_PATTERN,
  ALERT_TITLE_CLASS,
  alertTitle,
  alertType,
  parseAlertMarker,
} from './alert-presentation'
import type { ParsedAlertMarker } from './alert-presentation'
import { findInnermostDetailsBlocks } from './wysiwyg-details'
import {
  activateFloatingPanel,
  deactivateFloatingPanel,
  positionFloatingPanelAtTarget,
} from './floating-panel'
import { registerWysiwygDomFeature } from './wysiwyg-dom'
import {
  commitVditorWysiwygDomEdit,
  getVditorInternals,
} from './vditor-adapter'

const ALERT_MENU_ID = 'vmd-alert-type-menu'
const ALERT_MENU_CURRENT_CLASS = 'vmd-alert-type-menu__current'
const ALERT_CUSTOM_TITLE_INPUT_CLASS = 'vmd-alert-type-menu__custom-title-input'
const ALERT_TYPE_CLASSES = ALERT_TYPES.map(
  (type) => `${ALERT_CLASS}--${type.toLowerCase()}`
)
interface AlertMenuState {
  blockquote: HTMLElement
  marker: HTMLElement
  title: HTMLElement
  type: AlertType
}

function markerType(marker: HTMLElement): AlertType | null {
  return parseAlertMarker(marker.textContent || '')?.type || null
}

function markerWithCustomTitle(marker: HTMLElement, title: string): string | null {
  const value = marker.textContent || ''
  const typeMarker = ALERT_MARKER_TYPE_PATTERN.exec(value)?.[0]
  if (!typeMarker) return null
  const lineEnding = value.endsWith('\r\n')
    ? '\r\n'
    : value.endsWith('\n')
      ? '\n'
      : ''
  const normalizedTitle = title.trim()
  return `${typeMarker}${normalizedTitle ? ` ${normalizedTitle}` : ''}${lineEnding}`
}

interface AlertMarkerCandidate extends ParsedAlertMarker {
  firstText: Text | null
  marker: HTMLElement | null
}

function findMarker(paragraph: HTMLElement): AlertMarkerCandidate | null {
  const existing = paragraph.querySelector<HTMLElement>(
    `:scope > .${ALERT_MARKER_CLASS}`
  )
  const existingMarker = existing
    ? parseAlertMarker(existing.textContent || '')
    : null
  if (existing && existingMarker) {
    return {
      ...existingMarker,
      firstText: null,
      marker: existing,
    }
  }

  const first = paragraph.firstChild
  if (!(first instanceof Text)) return null
  const parsedMarker = parseAlertMarker(first.data)
  if (!parsedMarker) return null
  return {
    ...parsedMarker,
    firstText: first,
    marker: null,
  }
}

function createMarker(
  paragraph: HTMLElement,
  candidate: AlertMarkerCandidate
): HTMLElement | null {
  if (candidate.marker) return candidate.marker
  if (!candidate.firstText || !paragraph.contains(candidate.firstText)) return null

  const marker = document.createElement('span')
  marker.className = ALERT_MARKER_CLASS
  marker.setAttribute('contenteditable', 'false')
  marker.textContent = candidate.firstText.data.slice(0, candidate.matchLength)
  candidate.firstText.deleteData(0, candidate.matchLength)
  paragraph.insertBefore(marker, candidate.firstText)
  return marker
}

function firstContentElement(blockquote: HTMLElement): HTMLElement | null {
  return (
    Array.from(blockquote.children).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        !child.classList.contains(ALERT_TITLE_CLASS)
    ) || null
  )
}

function projectPreviewBlocks(clone: HTMLElement): void {
  clone
    .querySelectorAll<HTMLElement>('.vditor-wysiwyg__block')
    .forEach((block) => {
      const preview = block.querySelector<HTMLElement>(
        ':scope > .vditor-wysiwyg__preview'
      )
      if (!preview) {
        block.remove()
        return
      }
      block.replaceWith(...Array.from(preview.childNodes))
    })
}

function hasAlertBody(blockquote: HTMLElement): boolean {
  const clone = blockquote.cloneNode(true) as HTMLElement
  clone
    .querySelector(`:scope > .${ALERT_TITLE_CLASS}`)
    ?.remove()

  const paragraph = firstContentElement(clone)
  if (!paragraph || paragraph.tagName !== 'P') return false
  const existingMarker = paragraph.querySelector<HTMLElement>(
    `:scope > .${ALERT_MARKER_CLASS}`
  )
  if (existingMarker) {
    existingMarker.remove()
  } else {
    const first = paragraph.firstChild
    if (!(first instanceof Text)) return false
    const match = ALERT_MARKER_PATTERN.exec(first.data)
    if (!match) return false
    first.deleteData(0, match[0].length)
  }

  projectPreviewBlocks(clone)
  const visibleText = (clone.textContent || '')
    .replace(/[\u200b\ufeff]/g, '')
    .trim()
  if (visibleText) return true

  return Array.from(clone.querySelectorAll('*')).some(
    (element) => element.tagName !== 'P'
  )
}

function isTopLevelAlert(
  blockquote: HTMLElement,
  targetRoot: HTMLElement
): boolean {
  return (
    blockquote.parentElement === targetRoot &&
    !findInnermostDetailsBlocks(targetRoot, blockquote)
  )
}

function clearAlert(blockquote: HTMLElement): void {
  blockquote.classList.remove(ALERT_CLASS, ...ALERT_TYPE_CLASSES)
  blockquote.removeAttribute('data-vmd-alert')
  blockquote
    .querySelector(`:scope > .${ALERT_TITLE_CLASS}`)
    ?.remove()

  const paragraph = firstContentElement(blockquote)
  const marker = paragraph?.querySelector<HTMLElement>(
    `:scope > .${ALERT_MARKER_CLASS}`
  ) || null
  if (marker) marker.replaceWith(document.createTextNode(marker.textContent || ''))
}

function decorateAlert(
  blockquote: HTMLElement,
  targetRoot: HTMLElement
): void {
  const firstContent = firstContentElement(blockquote)
  if (
    !isTopLevelAlert(blockquote, targetRoot) ||
    !firstContent ||
    firstContent.tagName !== 'P'
  ) {
    clearAlert(blockquote)
    return
  }

  const candidate = findMarker(firstContent)
  if (!candidate || !hasAlertBody(blockquote)) {
    clearAlert(blockquote)
    return
  }
  const marker = createMarker(firstContent, candidate)
  if (!marker) {
    clearAlert(blockquote)
    return
  }

  blockquote.classList.remove(...ALERT_TYPE_CLASSES)
  blockquote.classList.add(
    ALERT_CLASS,
    `${ALERT_CLASS}--${candidate.type.toLowerCase()}`
  )
  blockquote.setAttribute('data-vmd-alert', candidate.type)

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
    blockquote.insertBefore(title, firstContent)
  }
  title.setAttribute(
    'aria-label',
    `${t('changeAlertType')}: ${candidate.type}`
  )
  const displayTitle = candidate.customTitle || alertTitle(candidate.type)
  if (
    title.getAttribute('data-vmd-alert-type') !== candidate.type ||
    title.getAttribute('data-vmd-alert-title') !== displayTitle
  ) {
    title.setAttribute('data-vmd-alert-type', candidate.type)
    title.setAttribute('data-vmd-alert-title', displayTitle)
    title.innerHTML = ALERT_ICONS[candidate.type]
    const label = document.createElement('span')
    label.textContent = displayTitle
    title.appendChild(label)
  }
}

interface AlertTypeMenu {
  customTitleInput: HTMLInputElement
  menu: HTMLDivElement
}

function createAlertTypeMenu(): AlertTypeMenu {
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

  const separator = document.createElement('div')
  separator.className = 'vmd-alert-type-menu__separator'
  separator.setAttribute('role', 'separator')
  const customTitleInput = document.createElement('input')
  customTitleInput.type = 'text'
  customTitleInput.className = ALERT_CUSTOM_TITLE_INPUT_CLASS
  customTitleInput.placeholder = t('customAlertTitle')
  customTitleInput.setAttribute('aria-label', t('customAlertTitle'))
  customTitleInput.autocomplete = 'off'
  customTitleInput.spellcheck = false
  const customTitleField = document.createElement('div')
  customTitleField.className = 'vmd-alert-type-menu__custom-title'
  customTitleField.setAttribute('role', 'none')
  customTitleField.appendChild(customTitleInput)
  menu.append(separator, customTitleField)

  document.body.appendChild(menu)
  return { customTitleInput, menu }
}

/** Adds GitHub Alert presentation and an in-place type picker. */
export function initWysiwygAlerts(): void {
  const { customTitleInput, menu } = createAlertTypeMenu()
  let state: AlertMenuState | null = null
  let initialMarkerText: string | null = null
  let root: HTMLElement | null = null

  function commitMenuChanges(
    current: AlertMenuState,
    initial: string
  ): void {
    if ((current.marker.textContent || '') === initial) return
    const internal = getVditorInternals()
    if (
      !root ||
      !internal ||
      internal.currentMode !== 'wysiwyg' ||
      !current.blockquote.isConnected ||
      !current.marker.isConnected ||
      !current.blockquote.contains(current.marker)
    ) {
      return
    }
    commitVditorWysiwygDomEdit(internal)
  }

  function hideMenu(): void {
    const current = state
    const initial = initialMarkerText
    deactivateFloatingPanel(menu)
    current?.title.setAttribute('aria-expanded', 'false')
    state = null
    initialMarkerText = null
    menu.style.display = 'none'
    menu.style.visibility = ''
    if (current && initial !== null) commitMenuChanges(current, initial)
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
    if (state?.title === nextState.title && menu.style.display === 'block') {
      hideMenu()
      return
    }

    hideMenu()
    state = nextState
    initialMarkerText = state.marker.textContent || ''
    customTitleInput.value =
      parseAlertMarker(initialMarkerText)?.customTitle || ''
    customTitleInput.setCustomValidity('')
    customTitleInput.removeAttribute('aria-invalid')
    state.title.setAttribute('aria-expanded', 'true')
    setCurrentType(state.type)
    activateFloatingPanel({
      panel: menu,
      safeTargets: [state.title],
      onDismiss: hideMenu,
    })
    positionFloatingPanelAtTarget(menu, state.title)
  }

  function refresh(targetRoot: HTMLElement): void {
    root = targetRoot
    targetRoot.querySelectorAll<HTMLElement>('blockquote').forEach(
      (blockquote) => decorateAlert(blockquote, targetRoot)
    )

    if (!state) return
    const type = state.marker.isConnected ? markerType(state.marker) : null
    if (!state.title.isConnected || !state.blockquote.isConnected || !type) {
      hideMenu()
      return
    }
    state.type = type
    setCurrentType(type)
  }

  function titleTarget(event: Event): AlertMenuState | null {
    const target = event.target instanceof Element ? event.target : null
    const title = target?.closest<HTMLElement>(`.${ALERT_TITLE_CLASS}`) || null
    const blockquote = title?.closest<HTMLElement>('blockquote') || null
    const paragraph = blockquote?.querySelector<HTMLElement>(
      ':scope > p:first-of-type'
    ) || null
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

  function updateCustomTitle(): void {
    const current = state
    if (
      !current ||
      !root ||
      !current.blockquote.isConnected ||
      !current.marker.isConnected ||
      !current.blockquote.contains(current.marker)
    ) {
      return
    }
    if (/[\u0000-\u001f\u007f]/.test(customTitleInput.value)) {
      customTitleInput.setCustomValidity('Custom title must be one line')
      customTitleInput.setAttribute('aria-invalid', 'true')
      return
    }

    customTitleInput.setCustomValidity('')
    customTitleInput.removeAttribute('aria-invalid')
    const replacement = markerWithCustomTitle(
      current.marker,
      customTitleInput.value
    )
    if (replacement === null || replacement === current.marker.textContent) {
      return
    }
    current.marker.textContent = replacement
    decorateAlert(current.blockquote, root)
  }

  function applyType(type: AlertType): void {
    const current = state
    if (
      current &&
      root &&
      current.blockquote.isConnected &&
      current.marker.isConnected &&
      current.blockquote.contains(current.marker)
    ) {
      const previousType = markerType(current.marker)
      const marker = current.marker.textContent || ''
      const replacement = previousType && previousType !== type
        ? marker.replace(ALERT_MARKER_TYPE_PATTERN, `[!${type}]`)
        : marker
      if (replacement !== marker) {
        current.marker.textContent = replacement
        current.type = type
        decorateAlert(current.blockquote, root)
      }
    }
    hideMenu()
  }

  customTitleInput.addEventListener('input', (event) => {
    if (event instanceof InputEvent && event.isComposing) return
    updateCustomTitle()
  })
  customTitleInput.addEventListener('compositionend', updateCustomTitle)

  menu.addEventListener('pointerdown', (event) => {
    if (event.target === customTitleInput) {
      event.stopPropagation()
      return
    }
    event.preventDefault()
    event.stopPropagation()
  })
  menu.addEventListener('click', (event) => {
    if (event.target === customTitleInput) {
      event.stopPropagation()
      return
    }
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
    if (event.target === customTitleInput) {
      if (event.isComposing || event.keyCode === 229) {
        event.stopPropagation()
        return
      }
      if (event.key === 'Escape' || event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        hideMenu()
        return
      }
      event.stopPropagation()
      return
    }

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

  registerWysiwygDomFeature({
    refresh,
    beforeRebind: hideMenu,
    onPointerDown: (event) => {
      if (!titleTarget(event)) return false
      // Keep the editable body selection while the non-editable title is clicked.
      event.preventDefault()
      event.stopImmediatePropagation()
      return true
    },
    onClick: (event) => {
      const nextState = titleTarget(event)
      if (!nextState) return false
      event.preventDefault()
      event.stopImmediatePropagation()
      showMenu(nextState)
      return true
    },
    dispose: () => {
      hideMenu()
      menu.remove()
      root = null
    },
  })
}
