import {
  commitVditorWysiwygDomEdit,
  getVditorInternals,
} from './vditor-adapter'

interface DetailsGroup {
  opener: HTMLElement
  contents: HTMLElement[]
  open: boolean
}

const DETAILS_SUMMARY_CLASS = 'vmd-details-summary'
const DETAILS_TOGGLE_CLASS = 'vmd-details-toggle'
const TITLE_EDIT_CLASS = 'vmd-details-title-edit'
const SUMMARY_COMMIT_DEBOUNCE_MS = 300

function getWysiwygRoot(): HTMLElement | null {
  return document.querySelector('.vditor-wysiwyg .vditor-reset')
}

function getHtmlBlockCode(block: HTMLElement): HTMLElement | null {
  return block.querySelector<HTMLElement>(
    ':scope > pre:not(.vditor-wysiwyg__preview) > code'
  )
}

function getHtmlBlockSource(block: HTMLElement): string {
  return (getHtmlBlockCode(block)?.textContent || '').trim()
}

function isDetailsOpenBlock(source: string): boolean {
  return /^<details(?:\s[^>]*)?>/i.test(source) && !/<\/details\s*>/i.test(source)
}

function countDetailsCloseTags(source: string): number {
  const closers = source.match(/<\/details\s*>/gi)
  if (!closers) return 0
  return source.replace(/<\/details\s*>/gi, '').trim() === ''
    ? closers.length
    : 0
}

function sourceStartsOpen(source: string): boolean {
  return /^<details\s+[^>]*\bopen(?:\s|=|>|$)/i.test(source)
}

function getPreviewDetails(opener: HTMLElement): HTMLDetailsElement | null {
  return opener.querySelector<HTMLDetailsElement>(
    ':scope > .vditor-wysiwyg__preview details'
  )
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Title text from <summary>, excluding the toggle arrow span and ZWSPs. */
function getSummaryTitleText(summary: HTMLElement): string {
  return Array.from(summary.childNodes)
    .filter(
      (n) =>
        !(n instanceof HTMLElement && n.classList.contains(DETAILS_TOGGLE_CLASS))
    )
    .map((n) => n.textContent || '')
    .join('')
    .replace(/​/g, '')
    .trim()
}

export function initWysiwygDetails() {
  const openState = new WeakMap<HTMLElement, boolean>()
  let root: HTMLElement | null = null
  let boundRoot: HTMLElement | null = null
  let observer: MutationObserver | null = null
  let summaryCommitTimer: number | null = null
  let pendingSummaryCommit: { opener: HTMLElement } | null = null
  const queuedRoots = new WeakSet<HTMLElement>()

  function refresh(targetRoot: HTMLElement): void {
    queuedRoots.delete(targetRoot)
    const children = Array.from(targetRoot.children) as HTMLElement[]
    for (const child of children) {
      child.classList.remove(
        'vmd-details-opener',
        'vmd-details-closer',
        'vmd-details-content--hidden',
        'vmd-details-content--open',
        'vmd-details-content--first',
        'vmd-details-content--last'
      )
    }

    const groups: DetailsGroup[] = []
    const stack: DetailsGroup[] = []
    for (const child of children) {
      const isHtmlBlock = child.getAttribute('data-type') === 'html-block'
      const source = isHtmlBlock ? getHtmlBlockSource(child) : ''

      if (isDetailsOpenBlock(source)) {
        for (const group of stack) group.contents.push(child)
        const group: DetailsGroup = {
          opener: child,
          contents: [],
          open: openState.get(child) ?? sourceStartsOpen(source),
        }
        groups.push(group)
        stack.push(group)
        child.classList.add('vmd-details-opener')
        continue
      }

      const closeCount = countDetailsCloseTags(source)
      if (closeCount > 0) {
        let closedAny = false
        for (let index = 0; index < closeCount; index += 1) {
          if (stack.pop()) closedAny = true
        }
        if (closedAny) child.classList.add('vmd-details-closer')
        for (const parent of stack) parent.contents.push(child)
        continue
      }

      for (const group of stack) group.contents.push(child)
    }

    const hiddenBy = new Map<HTMLElement, number>()
    for (const group of groups) {
      const preview = getPreviewDetails(group.opener)
      prepareSummaryDisplay(group.opener, group.open)
      preview?.toggleAttribute('open', group.open)
      if (group.open) {
        // Mark content blocks so CSS can draw a grouped border around them.
        const { contents } = group
        for (let i = 0; i < contents.length; i += 1) {
          const block = contents[i]
          block.classList.add('vmd-details-content--open')
          if (i === 0) block.classList.add('vmd-details-content--first')
          if (i === contents.length - 1) block.classList.add('vmd-details-content--last')
        }
      } else {
        for (const content of group.contents) {
          hiddenBy.set(content, (hiddenBy.get(content) || 0) + 1)
        }
      }
    }

    for (const [content] of hiddenBy) {
      content.classList.add('vmd-details-content--hidden')
    }
  }

  function queueRefresh(targetRoot: HTMLElement): void {
    if (queuedRoots.has(targetRoot)) return
    queuedRoots.add(targetRoot)
    queueMicrotask(() => refresh(targetRoot))
  }

  /** Returns the summary element + opener block if the event targets a summary. */
  function getSummaryTarget(event: Event): {
    summary: HTMLElement
    opener: HTMLElement
  } | null {
    const target = event.target instanceof Element ? event.target : null
    const summary = target?.closest<HTMLElement>(`.${DETAILS_SUMMARY_CLASS}`)
    const opener = summary?.closest<HTMLElement>('.vmd-details-opener')
    if (!summary || !opener || !root?.contains(opener)) return null
    const preview = getPreviewDetails(opener)
    if (!preview || !preview.contains(summary)) return null
    return { summary, opener }
  }

  /** Returns the title-edit div + opener block if the event targets the edit area. */
  function getTitleEditTarget(event: Event): {
    titleEdit: HTMLElement
    opener: HTMLElement
  } | null {
    const target = event.target instanceof Element ? event.target : null
    const titleEdit = target?.closest<HTMLElement>(`.${TITLE_EDIT_CLASS}`)
    const opener = titleEdit?.closest<HTMLElement>('.vmd-details-opener')
    if (!titleEdit || !opener || !root?.contains(opener)) return null
    return { titleEdit, opener }
  }

  function onRootClick(event: Event): void {
    const detailsTarget = getSummaryTarget(event)
    if (!detailsTarget) return

    event.preventDefault()
    event.stopImmediatePropagation()

    const { opener } = detailsTarget
    // Flush pending title edits before toggling so they are not lost.
    if (pendingSummaryCommit) flushSummaryCommit(false)

    const preview = getPreviewDetails(opener)
    if (!preview || !root) return
    openState.set(opener, !(openState.get(opener) ?? preview.open))
    queueRefresh(root)
  }

  function flushSummaryCommit(restoreCaret: boolean): void {
    if (summaryCommitTimer !== null) window.clearTimeout(summaryCommitTimer)
    summaryCommitTimer = null
    const pending = pendingSummaryCommit
    pendingSummaryCommit = null
    if (!pending) return
    const internal = getVditorInternals()
    if (!internal || internal.currentMode !== 'wysiwyg') return
    commitVditorWysiwygDomEdit(internal)
    // Browser preserves the caret in a contenteditable div naturally; no manual
    // restoration needed for the title-edit box.
    void restoreCaret
  }

  function scheduleTitleCommit(opener: HTMLElement): void {
    pendingSummaryCommit = { opener }
    if (summaryCommitTimer !== null) window.clearTimeout(summaryCommitTimer)
    summaryCommitTimer = window.setTimeout(
      () => flushSummaryCommit(false),
      SUMMARY_COMMIT_DEBOUNCE_MS
    )
  }

  function commitTitleEdit(event: Event): void {
    const target = getTitleEditTarget(event)
    if (!target) return
    event.stopImmediatePropagation()
    if (!syncTitleToSource(target.opener, target.titleEdit)) return
    scheduleTitleCommit(target.opener)
  }

  function onRootCompositionEnd(event: Event): void {
    const target = getTitleEditTarget(event)
    if (!target) return
    const internal = getVditorInternals()
    if (internal?.wysiwyg) internal.wysiwyg.composingLock = false
    event.stopImmediatePropagation()
    if (syncTitleToSource(target.opener, target.titleEdit)) {
      scheduleTitleCommit(target.opener)
    }
  }

  function onTitleEditBlur(event: FocusEvent): void {
    const target = getTitleEditTarget(event)
    if (!target || summaryCommitTimer === null) return
    syncTitleToSource(target.opener, target.titleEdit)
    flushSummaryCommit(false)
  }

  function onRootKeydown(event: KeyboardEvent): void {
    if (!getTitleEditTarget(event)) return
    // Keep title single-line.
    if (event.key === 'Enter') event.preventDefault()
    const isPrimary = event.ctrlKey || event.metaKey
    if (isPrimary && !event.altKey) {
      const key = event.key.toLowerCase()
      if (key === 'z' || key === 'y') {
        event.stopImmediatePropagation()
        return
      }
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      event.stopImmediatePropagation()
    }
  }

  function onRootKeyup(event: KeyboardEvent): void {
    if (getTitleEditTarget(event)) event.stopImmediatePropagation()
  }

  function unbindRoots(): void {
    observer?.disconnect()
    observer = null
    if (boundRoot) {
      boundRoot.removeEventListener('click', onRootClick, true)
      boundRoot.removeEventListener('input', commitTitleEdit, true)
      boundRoot.removeEventListener('compositionend', onRootCompositionEnd, true)
      boundRoot.removeEventListener('blur', onTitleEditBlur, true)
      boundRoot.removeEventListener('keydown', onRootKeydown, true)
      boundRoot.removeEventListener('keyup', onRootKeyup, true)
      boundRoot = null
    }
  }

  function rebind(): void {
    const nextRoot = getWysiwygRoot()
    if (nextRoot === root && boundRoot === nextRoot) {
      if (root) queueRefresh(root)
      return
    }
    if (summaryCommitTimer !== null) window.clearTimeout(summaryCommitTimer)
    summaryCommitTimer = null
    pendingSummaryCommit = null
    unbindRoots()
    root = nextRoot
    if (root) {
      const observedRoot = root
      observedRoot.addEventListener('click', onRootClick, true)
      observedRoot.addEventListener('input', commitTitleEdit, true)
      observedRoot.addEventListener('compositionend', onRootCompositionEnd, true)
      observedRoot.addEventListener('blur', onTitleEditBlur, true)
      observedRoot.addEventListener('keydown', onRootKeydown, true)
      observedRoot.addEventListener('keyup', onRootKeyup, true)
      boundRoot = observedRoot

      observer = new MutationObserver(() => queueRefresh(observedRoot))
      observer.observe(observedRoot, {
        childList: true,
        subtree: true,
        characterData: true,
      })
      queueRefresh(observedRoot)
    }
  }

  rebind()
  return {
    rebind,
    dispose() {
      if (summaryCommitTimer !== null) window.clearTimeout(summaryCommitTimer)
      summaryCommitTimer = null
      pendingSummaryCommit = null
      unbindRoots()
      root = null
    },
  }
}

/**
 * Sets up the <summary> element (non-editable, with toggle arrow) and manages
 * the title-edit box that appears below it when the details block is open.
 */
function prepareSummaryDisplay(opener: HTMLElement, isOpen: boolean): void {
  const details = getPreviewDetails(opener)
  if (!details) return
  const summary = details.querySelector<HTMLElement>(':scope > summary')
  if (!summary) return

  // Summary is read-only — cursor cannot be placed inside it.
  summary.classList.add(DETAILS_SUMMARY_CLASS)
  summary.removeAttribute('contenteditable')

  let toggle = summary.querySelector<HTMLElement>(
    `:scope > .${DETAILS_TOGGLE_CLASS}`
  )
  if (!toggle) {
    toggle = document.createElement('span')
    toggle.className = DETAILS_TOGGLE_CLASS
    toggle.setAttribute('contenteditable', 'false')
    toggle.setAttribute('aria-hidden', 'true')
    summary.prepend(toggle)
  }

  // Title-edit box: injected when open, removed when closed.
  const existingEdit = details.querySelector<HTMLElement>(
    `:scope > .${TITLE_EDIT_CLASS}`
  )
  if (isOpen) {
    if (!existingEdit) {
      const titleEdit = document.createElement('div')
      titleEdit.className = TITLE_EDIT_CLASS
      titleEdit.setAttribute('contenteditable', 'true')
      titleEdit.textContent = getSummaryTitleText(summary)
      summary.insertAdjacentElement('afterend', titleEdit)
    }
  } else {
    existingEdit?.remove()
  }
}

/**
 * Reads the title from the edit box and writes it into the hidden HTML source.
 * Returns true when the source actually changed.
 */
function syncTitleToSource(
  opener: HTMLElement,
  titleEdit: HTMLElement
): boolean {
  const code = getHtmlBlockCode(opener)
  if (!code) return false
  const source = code.textContent || ''
  const title = escapeHtmlText(
    titleEdit.textContent?.replace(/​/g, '') || ''
  )
  const nextSource = source.replace(
    /(<summary(?:\s[^>]*)?>)[\s\S]*?(<\/summary\s*>)/i,
    `$1${title}$2`
  )
  if (nextSource === source) return false
  code.textContent = nextSource
  return true
}
