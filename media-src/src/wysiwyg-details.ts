interface DetailsGroup {
  opener: HTMLElement
  contents: HTMLElement[]
  open: boolean
}

function getWysiwygRoot(): HTMLElement | null {
  return document.querySelector('.vditor-wysiwyg .vditor-reset')
}

function getHtmlBlockSource(block: HTMLElement): string {
  return (
    block.querySelector<HTMLElement>(
      ':scope > pre:not(.vditor-wysiwyg__preview) > code'
    )?.textContent || ''
  ).trim()
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
  // The element the click handler is currently attached to. Tracked separately
  // from `root` so rebind() can unbind the previous root: the handler closes
  // over the shared `root` variable, so a stale listener left behind would
  // still pass its containment check and toggle openState a second time,
  // cancelling out the first toggle and making summaries stop responding.
  let boundRoot: HTMLElement | null = null
  let observer: MutationObserver | null = null
  let refreshQueued = false

  function refresh(): void {
    refreshQueued = false
    if (!root) return

    const children = Array.from(root.children) as HTMLElement[]
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
      const isHtmlBlock =
        child.classList.contains('vditor-wysiwyg__block') &&
        child.getAttribute('data-type') === 'html-block'
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

  function queueRefresh(): void {
    if (refreshQueued) return
    refreshQueued = true
    queueMicrotask(refresh)
  }

  // Declared once so it stays a stable reference for removeEventListener.
  function onRootClick(event: Event): void {
    const target = event.target as HTMLElement | null
    const summary = target?.closest<HTMLElement>('summary')
    const opener = summary?.closest<HTMLElement>('.vmd-details-opener')
    if (!summary || !opener || !root?.contains(opener)) return

    const preview = getPreviewDetails(opener)
    if (!preview || !preview.contains(summary)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    openState.set(opener, !(openState.get(opener) ?? preview.open))
    queueRefresh()
  }

  function unbindRoot(): void {
    observer?.disconnect()
    observer = null
    if (boundRoot) {
      boundRoot.removeEventListener('click', onRootClick, true)
      boundRoot = null
    }
  }

  function rebind(): void {
    const nextRoot = getWysiwygRoot()
    if (nextRoot === root && boundRoot === nextRoot) {
      queueRefresh()
      return
    }

    unbindRoot()
    root = nextRoot
    if (!root) return

    root.addEventListener('click', onRootClick, true)
    boundRoot = root

    observer = new MutationObserver(queueRefresh)
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    queueRefresh()
  }

  rebind()
  return {
    rebind,
    dispose() {
      unbindRoot()
      root = null
    },
  }
}
