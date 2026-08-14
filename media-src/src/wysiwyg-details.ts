import { t } from './lang'
import { registerWysiwygDomFeature } from './wysiwyg-dom'
import {
  closeActiveWysiwygPopover,
  createWysiwygSourceEditButton,
  getSharedWysiwygPopover,
  openWysiwygSourceEditSession,
} from './wysiwyg-popover'

interface DetailsGroup {
  opener: HTMLElement
  contents: HTMLElement[]
  open: boolean
}

const DETAILS_SUMMARY_CLASS = 'vmd-details-summary'
const DETAILS_TOGGLE_CLASS = 'vmd-details-toggle'
const TITLE_BUTTON_CLASS = 'vmd-details-title-button'

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

function getPreviewDetails(opener: HTMLElement): HTMLDetailsElement | null {
  return opener.querySelector<HTMLDetailsElement>(
    ':scope > .vditor-wysiwyg__preview details'
  )
}

function escapeHtmlText(value: string): string {
  // Vditor decodes one entity layer when it serializes this hidden HTML-block
  // source. Encode that layer as well so the resulting Markdown still contains
  // safe HTML entities rather than turning title text into markup.
  return value
    .replace(/&/g, '&amp;amp;')
    .replace(/</g, '&amp;lt;')
    .replace(/>/g, '&amp;gt;')
}

/** Title text from <summary>, excluding the toggle arrow span and ZWSPs. */
function getSummaryTitleText(summary: HTMLElement): string {
  return Array.from(summary.childNodes)
    .filter(
      (n) =>
        !(
          n instanceof HTMLElement &&
          (n.classList.contains(DETAILS_TOGGLE_CLASS) ||
            n.classList.contains(TITLE_BUTTON_CLASS))
        )
    )
    .map((n) => n.textContent || '')
    .join('')
    .replace(/​/g, '')
    .trim()
}

interface DetailsRegion {
  start: number
  end: number
}

/**
 * Finds the innermost complete details region represented by Vditor's sibling
 * blocks. Content between the HTML opener and its matching closer is not a DOM
 * child of `<details>`, so ordinary `closest()` lookup cannot identify it.
 */
export function findInnermostDetailsBlocks(
  root: HTMLElement,
  target: Element
): HTMLElement[] | null {
  const children = Array.from(root.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement
  )
  const targetIndex = children.findIndex(
    (child) => child === target || child.contains(target)
  )
  if (targetIndex < 0) return null

  const regions: DetailsRegion[] = []
  const stack: DetailsRegion[] = []
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    const source =
      child.getAttribute('data-type') === 'html-block'
        ? getHtmlBlockSource(child)
        : ''

    if (isDetailsOpenBlock(source)) {
      const region = { start: index, end: -1 }
      regions.push(region)
      stack.push(region)
      continue
    }

    const closeCount = countDetailsCloseTags(source)
    for (let closeIndex = 0; closeIndex < closeCount; closeIndex += 1) {
      const region = stack.pop()
      if (region) region.end = index
    }
  }

  const region = regions
    .filter(
      (candidate) =>
        candidate.end >= candidate.start &&
        targetIndex >= candidate.start &&
        targetIndex <= candidate.end
    )
    .sort((left, right) => {
      if (left.start !== right.start) return right.start - left.start
      return left.end - right.end
    })[0]

  return region ? children.slice(region.start, region.end + 1) : null
}

export function initWysiwygDetails(): void {
  const openState = new WeakMap<HTMLElement, boolean>()

  function refresh(targetRoot: HTMLElement): void {
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
          open:
            openState.get(child) ??
            (getPreviewDetails(child)?.hasAttribute('open') || false),
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
        const { contents } = group
        for (let index = 0; index < contents.length; index += 1) {
          const block = contents[index]
          block.classList.add('vmd-details-content--open')
          if (index === 0) block.classList.add('vmd-details-content--first')
          if (index === contents.length - 1) {
            block.classList.add('vmd-details-content--last')
          }
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

  function getSummaryTarget(
    event: Event,
    root: HTMLElement
  ): { summary: HTMLElement; opener: HTMLElement } | null {
    const target = event.target instanceof Element ? event.target : null
    const summary = target?.closest<HTMLElement>(`.${DETAILS_SUMMARY_CLASS}`)
    const opener = summary?.closest<HTMLElement>('.vmd-details-opener')
    if (!summary || !opener || !root.contains(opener)) return null
    const preview = getPreviewDetails(opener)
    if (!preview || !preview.contains(summary)) return null
    return { summary, opener }
  }

  function getTitleButtonTarget(
    event: Event,
    root: HTMLElement
  ): { button: HTMLButtonElement; opener: HTMLElement } | null {
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest<HTMLButtonElement>(`.${TITLE_BUTTON_CLASS}`)
    const opener = button?.closest<HTMLElement>('.vmd-details-opener')
    if (!button || !opener || !root.contains(opener)) return null
    return { button, opener }
  }

  function hideSharedPopover(): void {
    closeActiveWysiwygPopover()
    const popover = getSharedWysiwygPopover()
    if (popover) popover.style.display = 'none'
  }

  function openTitleEditor(
    button: HTMLButtonElement,
    opener: HTMLElement
  ): void {
    const summary = getPreviewDetails(opener)
      ?.querySelector<HTMLElement>(':scope > summary')
    const code = getHtmlBlockCode(opener)
    if (!summary || !code) return
    const initialTitle = getSummaryTitleText(summary)
    const initialSource = code.textContent || ''

    openWysiwygSourceEditSession({
      target: button,
      focusField: 'title',
      fields: [
        {
          name: 'title',
          label: t('editDetailsTitle'),
          value: initialTitle,
          closeOnEnter: true,
        },
      ],
      unavailableMessage: 'The Details title is no longer available',
      isAvailable: () => opener.isConnected && code.isConnected,
      onChange: (values) => {
        const value = values.title ?? ''
        if (syncTitleToSource(opener, value)) {
          setVisibleSummaryTitle(opener, value)
        }
        return null
      },
      isSourceChanged: () => (code.textContent || '') !== initialSource,
      afterCommit: () => registration.requestRefresh(),
    })
  }

  const registration = registerWysiwygDomFeature({
    refresh,
    beforeRebind: closeActiveWysiwygPopover,
    onClick: (event, root) => {
      const titleTarget = getTitleButtonTarget(event, root)
      if (titleTarget) {
        event.preventDefault()
        event.stopImmediatePropagation()
        openTitleEditor(titleTarget.button, titleTarget.opener)
        return true
      }

      const detailsTarget = getSummaryTarget(event, root)
      if (!detailsTarget) return false
      event.preventDefault()
      event.stopImmediatePropagation()
      const { opener } = detailsTarget
      hideSharedPopover()
      const preview = getPreviewDetails(opener)
      if (!preview) return true
      openState.set(opener, !(openState.get(opener) ?? preview.open))
      registration.requestRefresh()
      return true
    },
  })
}

/** Adds read-only disclosure controls without exposing the HTML source. */
function prepareSummaryDisplay(opener: HTMLElement, _isOpen: boolean): void {
  const details = getPreviewDetails(opener)
  if (!details) return
  const summary = details.querySelector<HTMLElement>(':scope > summary')
  if (!summary) return

  summary.classList.add(DETAILS_SUMMARY_CLASS)
  summary.setAttribute('contenteditable', 'false')

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

  let titleButton = summary.querySelector<HTMLButtonElement>(
    `:scope > .${TITLE_BUTTON_CLASS}`
  )
  if (!titleButton) {
    titleButton = createWysiwygSourceEditButton(
      t('editDetailsTitle'),
      TITLE_BUTTON_CLASS
    )
    summary.append(titleButton)
  } else {
    titleButton.setAttribute('aria-label', t('editDetailsTitle'))
  }
}

function setVisibleSummaryTitle(opener: HTMLElement, value: string): void {
  const summary = getPreviewDetails(opener)
    ?.querySelector<HTMLElement>(':scope > summary')
  if (!summary) return
  const titleButton = summary.querySelector<HTMLElement>(
    `:scope > .${TITLE_BUTTON_CLASS}`
  )
  Array.from(summary.childNodes).forEach((node) => {
    const isControl =
      node instanceof HTMLElement &&
      (node.classList.contains(DETAILS_TOGGLE_CLASS) ||
        node.classList.contains(TITLE_BUTTON_CLASS))
    if (!isControl) node.remove()
  })
  summary.insertBefore(
    document.createTextNode(value.replace(/​/g, '')),
    titleButton
  )
}

/** Writes a plain-text title into the hidden HTML source. */
function syncTitleToSource(opener: HTMLElement, value: string): boolean {
  const code = getHtmlBlockCode(opener)
  if (!code) return false
  const source = code.textContent || ''
  const title = escapeHtmlText(value.replace(/​/g, ''))
  const nextSource = source.replace(
    /(<summary(?:\s[^>]*)?>)[\s\S]*?(<\/summary\s*>)/i,
    (_match, opening: string, closing: string) => `${opening}${title}${closing}`
  )
  if (nextSource === source) return false
  code.textContent = nextSource
  return true
}
