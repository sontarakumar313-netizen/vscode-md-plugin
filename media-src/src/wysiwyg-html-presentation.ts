const ALIGNMENTS = ['left', 'center', 'right', 'justify'] as const
type HtmlAlignment = (typeof ALIGNMENTS)[number]
const ALIGN_CLASS_PREFIX = 'vmd-html-align-'
const SOURCE_TOKEN_CLASS = 'vmd-html-inline-projected-source'
const ZERO_WIDTH_SPACE = '\u200b'

function getWysiwygRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '.vditor-wysiwyg .vditor-reset'
  )
}

function tokenText(token: HTMLElement): string {
  return (token.textContent || '').replaceAll(ZERO_WIDTH_SPACE, '').trim()
}

function openingParagraphAlignment(token: HTMLElement): HtmlAlignment | null {
  const source = tokenText(token)
  const match = /^<p\s+align\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))\s*>$/i.exec(
    source
  )
  const value = (match?.[1] || match?.[2] || match?.[3] || '').toLowerCase()
  return ALIGNMENTS.includes(value as HtmlAlignment)
    ? (value as HtmlAlignment)
    : null
}

function isClosingParagraph(token: HTMLElement): boolean {
  return /^<\/p\s*>$/i.test(tokenText(token))
}

function meaningfulChildren(heading: HTMLElement): ChildNode[] {
  return Array.from(heading.childNodes).filter((node) => {
    if (
      node instanceof HTMLElement &&
      node.getAttribute('data-render') === '1'
    ) {
      return false
    }
    return node.nodeType !== Node.TEXT_NODE ||
      !!node.textContent?.replaceAll(ZERO_WIDTH_SPACE, '').trim()
  })
}

function clearHeadingProjection(heading: HTMLElement): void {
  for (const alignment of ALIGNMENTS) {
    heading.classList.remove(`${ALIGN_CLASS_PREFIX}${alignment}`)
  }
  heading
    .querySelectorAll<HTMLElement>(`:scope > .${SOURCE_TOKEN_CLASS}`)
    .forEach((token) => token.classList.remove(SOURCE_TOKEN_CLASS))
}

function decorateHeading(heading: HTMLElement): void {
  clearHeadingProjection(heading)
  const children = meaningfulChildren(heading)
  const first = children[0]
  const last = children[children.length - 1]
  if (
    !(first instanceof HTMLElement) ||
    !(last instanceof HTMLElement) ||
    first === last ||
    !first.matches('code[data-type="html-inline"]') ||
    !last.matches('code[data-type="html-inline"]') ||
    !isClosingParagraph(last)
  ) {
    return
  }
  const alignment = openingParagraphAlignment(first)
  if (!alignment) return
  const hasText = children
    .slice(1, -1)
    .some((node) => !!node.textContent?.replaceAll(ZERO_WIDTH_SPACE, '').trim())
  if (!hasText) return
  first.classList.add(SOURCE_TOKEN_CLASS)
  last.classList.add(SOURCE_TOKEN_CLASS)
  heading.classList.add(`${ALIGN_CLASS_PREFIX}${alignment}`)
}

/** Adds safe display-only classes to raw HTML previews and heading wrappers. */
export function initWysiwygHtmlPresentation(): { rebind(): void } {
  let root: HTMLElement | null = null
  let observer: MutationObserver | null = null
  let refreshQueued = false

  function refresh(): void {
    refreshQueued = false
    if (!root) return
    root
      .querySelectorAll<HTMLElement>(
        '.vditor-wysiwyg__block[data-type="html-block"] > .vditor-wysiwyg__preview'
      )
      .forEach((preview) => {
        preview.classList.add('vmd-html-transparent-preview')
      })
    root
      .querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')
      .forEach(decorateHeading)
  }

  function queueRefresh(): void {
    if (refreshQueued) return
    refreshQueued = true
    queueMicrotask(refresh)
  }

  function rebind(): void {
    const nextRoot = getWysiwygRoot()
    if (nextRoot === root) {
      queueRefresh()
      return
    }
    observer?.disconnect()
    root = nextRoot
    if (!root) return
    observer = new MutationObserver(queueRefresh)
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    queueRefresh()
  }

  rebind()
  return { rebind }
}
