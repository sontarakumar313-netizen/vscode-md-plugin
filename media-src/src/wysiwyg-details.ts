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

function getWysiwygRoot(): HTMLElement | null {
  return document.querySelector('.vditor-wysiwyg .vditor-reset')
}

function getIrRoot(): HTMLElement | null {
  return document.querySelector('.vditor-ir .vditor-reset')
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

/**
 * Returns how many groups this block closes, or 0 if it is not a pure run of
 * closing tags. Adjacent `</details>` lines with no blank line between them
 * arrive as a single HTML block, so requiring the block to be exactly one
 * closer left the stack unwound: every following sibling was then collected as
 * content of a group the source had already closed, and hidden with it.
 */
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

export function initWysiwygDetails() {
  const openState = new WeakMap<HTMLElement, boolean>()
  let root: HTMLElement | null = null
  let irRoot: HTMLElement | null = null
  // The element the click handler is currently attached to. Tracked separately
  // from `root` so rebind() can unbind the previous root: the handler closes
  // over the shared `root` variable, so a stale listener left behind would
  // still pass its containment check and toggle openState a second time,
  // cancelling out the first toggle and making summaries stop responding.
  let boundRoot: HTMLElement | null = null
  let observer: MutationObserver | null = null
  let irObserver: MutationObserver | null = null
  const queuedRoots = new WeakSet<HTMLElement>()

  function refresh(targetRoot: HTMLElement, manageOpenState: boolean): void {
    queuedRoots.delete(targetRoot)
    const children = Array.from(targetRoot.children) as HTMLElement[]
    for (const child of children) {
      child.classList.remove(
        'vmd-details-opener',
        'vmd-details-closer',
        'vmd-details-content--hidden'
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
      if (!manageOpenState) continue
      const preview = getPreviewDetails(group.opener)
      prepareEditableSummary(group.opener)
      preview?.toggleAttribute('open', group.open)
      if (group.open) continue
      for (const content of group.contents) {
        hiddenBy.set(content, (hiddenBy.get(content) || 0) + 1)
      }
    }

    for (const [content] of hiddenBy) {
      content.classList.add('vmd-details-content--hidden')
    }
  }

  function queueRefresh(targetRoot: HTMLElement, manageOpenState: boolean): void {
    if (queuedRoots.has(targetRoot)) return
    queuedRoots.add(targetRoot)
    queueMicrotask(() => refresh(targetRoot, manageOpenState))
  }

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

  // Declared once so they stay stable references for removeEventListener.
  function onRootClick(event: Event): void {
    const detailsTarget = getSummaryTarget(event)
    if (!detailsTarget) return

    event.preventDefault()
    event.stopImmediatePropagation()
    const target = event.target instanceof Element ? event.target : null
    if (!target?.closest(`.${DETAILS_TOGGLE_CLASS}`)) return

    const { opener } = detailsTarget
    const preview = getPreviewDetails(opener)
    if (!preview || !root) return
    openState.set(opener, !(openState.get(opener) ?? preview.open))
    queueRefresh(root, true)
  }

  function commitSummaryEdit(event: Event): void {
    const detailsTarget = getSummaryTarget(event)
    if (!detailsTarget) return
    event.stopImmediatePropagation()
    if (!syncSummaryToSource(detailsTarget.opener, detailsTarget.summary)) return
    commitVditorWysiwygDomEdit(getVditorInternals())
  }

  function onRootCompositionEnd(event: Event): void {
    const detailsTarget = getSummaryTarget(event)
    if (!detailsTarget) return
    const internal = getVditorInternals()
    if (internal?.wysiwyg) internal.wysiwyg.composingLock = false
    event.stopImmediatePropagation()
    if (syncSummaryToSource(detailsTarget.opener, detailsTarget.summary)) {
      commitVditorWysiwygDomEdit(internal)
    }
  }

  function onRootKeydown(event: KeyboardEvent): void {
    if (!getSummaryTarget(event)) return
    if (event.key === 'Enter') event.preventDefault()
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      event.stopImmediatePropagation()
    }
  }

  function onRootKeyup(event: KeyboardEvent): void {
    if (getSummaryTarget(event)) event.stopImmediatePropagation()
  }

  function unbindRoots(): void {
    observer?.disconnect()
    observer = null
    irObserver?.disconnect()
    irObserver = null
    if (boundRoot) {
      boundRoot.removeEventListener('click', onRootClick, true)
      boundRoot.removeEventListener('input', commitSummaryEdit, true)
      boundRoot.removeEventListener('compositionend', onRootCompositionEnd, true)
      boundRoot.removeEventListener('keydown', onRootKeydown, true)
      boundRoot.removeEventListener('keyup', onRootKeyup, true)
      boundRoot = null
    }
  }

  function rebind(): void {
    const nextRoot = getWysiwygRoot()
    const nextIrRoot = getIrRoot()
    if (
      nextRoot === root &&
      boundRoot === nextRoot &&
      nextIrRoot === irRoot
    ) {
      if (root) queueRefresh(root, true)
      if (irRoot) queueRefresh(irRoot, false)
      return
    }

    unbindRoots()
    root = nextRoot
    irRoot = nextIrRoot
    if (root) {
      const observedRoot = root
      observedRoot.addEventListener('click', onRootClick, true)
      observedRoot.addEventListener('input', commitSummaryEdit, true)
      observedRoot.addEventListener('compositionend', onRootCompositionEnd, true)
      observedRoot.addEventListener('keydown', onRootKeydown, true)
      observedRoot.addEventListener('keyup', onRootKeyup, true)
      boundRoot = observedRoot

      observer = new MutationObserver(() => queueRefresh(observedRoot, true))
      observer.observe(observedRoot, {
        childList: true,
        subtree: true,
        characterData: true,
      })
      queueRefresh(observedRoot, true)
    }

    if (irRoot) {
      const observedIrRoot = irRoot
      irObserver = new MutationObserver(() => queueRefresh(observedIrRoot, false))
      irObserver.observe(observedIrRoot, {
        childList: true,
        subtree: true,
        characterData: true,
      })
      queueRefresh(observedIrRoot, false)
    }
  }

  rebind()
  return {
    rebind,
    dispose() {
      unbindRoots()
      root = null
      irRoot = null
    },
  }
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function prepareEditableSummary(opener: HTMLElement): HTMLElement | null {
  const summary = getPreviewDetails(opener)?.querySelector<HTMLElement>(
    ':scope > summary'
  )
  if (!summary) return null

  summary.classList.add(DETAILS_SUMMARY_CLASS)
  summary.setAttribute('contenteditable', 'true')
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
  return summary
}

/**
 * Keep Vditor's hidden HTML source authoritative while the rendered summary is
 * edited directly. The injected toggle has no text, so textContent is exactly
 * the visible title and no plugin-only markup can leak into Markdown.
 */
function syncSummaryToSource(opener: HTMLElement, summary: HTMLElement): boolean {
  const code = getHtmlBlockCode(opener)
  if (!code) return false
  const source = code.textContent || ''
  const title = escapeHtmlText(summary.textContent?.replace(/\u200b/g, '') || '')
  const nextSource = source.replace(
    /(<summary(?:\s[^>]*)?>)[\s\S]*?(<\/summary\s*>)/i,
    `$1${title}$2`
  )
  if (nextSource === source) return false
  code.textContent = nextSource
  return true
}
