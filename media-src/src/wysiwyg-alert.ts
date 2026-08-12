const ALERT_TYPES = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const

type AlertType = typeof ALERT_TYPES[number]

const ALERT_CLASS = 'vmd-alert'
const ALERT_MARKER_CLASS = 'vmd-alert-marker'
const ALERT_TITLE_CLASS = 'vmd-alert-title'
const ALERT_TYPE_CLASSES = ALERT_TYPES.map(
  (type) => `${ALERT_CLASS}--${type.toLowerCase()}`
)
const ALERT_MARKER_PATTERN = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/

const ALERT_ICONS: Record<AlertType, string> = {
  NOTE: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M8 7v4M8 4.5h.01"/></svg>',
  TIP: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.4 11h5.2M6 13h4M8 2.2a4.2 4.2 0 0 0-2.5 7.6c.5.4.8.8.9 1.2h3.2c.1-.4.4-.8.9-1.2A4.2 4.2 0 0 0 8 2.2Z"/></svg>',
  IMPORTANT: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.7 14 5v6l-6 3.3L2 11V5l6-3.3ZM8 5v3.5M8 11h.01"/></svg>',
  WARNING: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 14.3 14H1.7L8 1.8ZM8 6v3.5M8 12h.01"/></svg>',
  CAUTION: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 1.7-3.3 3.3v6L5 14.3h6l3.3-3.3V5L11 1.7H5ZM8 5v3.5M8 11h.01"/></svg>',
}

function getWysiwygRoot(): HTMLElement | null {
  return document.querySelector('.vditor-wysiwyg .vditor-reset')
}

function markerType(marker: HTMLElement): AlertType | null {
  const match = ALERT_MARKER_PATTERN.exec(marker.textContent || '')
  return match ? (match[1] as AlertType) : null
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
  if (!match) return null

  const marker = document.createElement('span')
  marker.className = ALERT_MARKER_CLASS
  marker.setAttribute('contenteditable', 'false')
  marker.textContent = match[0]
  first.deleteData(0, match[0].length)
  paragraph.insertBefore(marker, first)
  return { marker, type: match[1] as AlertType }
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
    title = document.createElement('div')
    title.className = `vditor-wysiwyg__preview ${ALERT_TITLE_CLASS}`
    title.setAttribute('data-render', '1')
    title.setAttribute('contenteditable', 'false')
    blockquote.insertBefore(title, paragraph)
  }
  if (title.getAttribute('data-vmd-alert-title') !== alert.type) {
    title.setAttribute('data-vmd-alert-title', alert.type)
    title.innerHTML = `${ALERT_ICONS[alert.type]}<span>${alert.type}</span>`
  }
}

/** Adds GitHub Alert presentation without changing the serialized Markdown. */
export function initWysiwygAlerts() {
  let root: HTMLElement | null = null
  let observer: MutationObserver | null = null
  const queuedRoots = new WeakSet<HTMLElement>()

  function refresh(targetRoot: HTMLElement): void {
    queuedRoots.delete(targetRoot)
    targetRoot.querySelectorAll<HTMLElement>('blockquote').forEach(decorateAlert)
  }

  function queueRefresh(targetRoot: HTMLElement): void {
    if (queuedRoots.has(targetRoot)) return
    queuedRoots.add(targetRoot)
    queueMicrotask(() => refresh(targetRoot))
  }

  function rebind(): void {
    const nextRoot = getWysiwygRoot()
    if (nextRoot === root) {
      if (root) queueRefresh(root)
      return
    }

    observer?.disconnect()
    observer = null
    root = nextRoot
    if (!root) return

    const observedRoot = root
    observer = new MutationObserver(() => queueRefresh(observedRoot))
    observer.observe(observedRoot, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    queueRefresh(observedRoot)
  }

  rebind()
  return { rebind }
}
