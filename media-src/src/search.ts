/**
 * In-editor find/replace using canonical Markdown for mutations and the CSS
 * Custom Highlight API for display. Editor DOM remains Vditor-owned.
 */

import { t } from './lang'
import { getVditorEditorElement, getVditorMode } from './vditor-adapter'
import type { VditorMode } from './vditor-adapter'

type SourceSpan = {
  start: number
  end: number
}

/**
 * Every match carries the source span it came from, so the offsets used to
 * mutate Markdown cannot drift out of step with the range used to highlight it.
 * `source` is null in the modes that have no exact offset mapping, and that is
 * what disables replacement -- not a count comparison between two lists that
 * were built independently and could agree while pointing at different text.
 */
type SearchMatch = {
  range: Range
  source: SourceSpan | null
}

type SourceTextRun = {
  node: Text
  start: number
  end: number
}

let matches: SearchMatch[] = []
let currentIndex = -1
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findSourceMatches(
  source: string,
  query: string,
  caseSensitive: boolean
): SourceSpan[] {
  if (!query) return []

  const regex = new RegExp(escapeRegex(query), caseSensitive ? 'g' : 'gi')
  const spans: SourceSpan[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(source)) !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length })
  }
  return spans
}

function getEditorRoot(): Element | null {
  const mode = getVditorMode()
  const roots: Record<VditorMode, Element | null> = {
    wysiwyg: document.querySelector('.vditor-wysiwyg .vditor-reset'),
    sv: document.querySelector('.vditor-sv.vditor-reset'),
  }
  if (mode && roots[mode]) return roots[mode]

  return (
    Object.values(roots).find(
      (root) => root && root.getClientRects().length > 0
    ) || null
  )
}

/**
 * Highlight-only fallback for the rendered modes. Matches cannot cross a text
 * node here, which is why these matches never carry a source span.
 */
function findDomMatches(
  root: Element,
  query: string,
  caseSensitive: boolean
): Range[] {
  const regex = new RegExp(escapeRegex(query), caseSensitive ? 'g' : 'gi')
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)

  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const text = node.textContent || ''
    regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      const range = document.createRange()
      range.setStart(node, match.index)
      range.setEnd(node, match.index + match[0].length)
      ranges.push(range)
    }
  }
  return ranges
}

function collectSourceTextRuns(root: Element): {
  text: string
  runs: SourceTextRun[]
} {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const runs: SourceTextRun[] = []
  let text = ''

  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const value = node.textContent || ''
    if (!value) continue
    runs.push({ node, start: text.length, end: text.length + value.length })
    text += value
  }
  return { text, runs }
}

/**
 * Split View builds its Markdown from the source pane's own `textContent`: it
 * appends a newline, collapses a doubled trailing newline, and maps U+00A0 to a
 * space. Only the last of those can alter a character, and it is a same-length
 * substitution, so every offset before `textContent`'s end addresses the same
 * character in both strings. Confirming the prefix relation holds keeps the
 * mapping honest if a future Vditor changes that derivation.
 */
function sourceMatchesDomText(source: string, domText: string): boolean {
  return source.startsWith(domText.replace(/\u00a0/g, ' '))
}

function locateSourceOffset(
  runs: SourceTextRun[],
  offset: number
): { node: Text; offset: number } | null {
  // Runs are ascending and contiguous, so a binary search keeps the mapping
  // logarithmic rather than rescanning every text node for every match.
  let low = 0
  let high = runs.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const run = runs[middle]
    if (offset < run.start) {
      high = middle - 1
    } else if (offset >= run.end) {
      low = middle + 1
    } else {
      return { node: run.node, offset: offset - run.start }
    }
  }

  // An offset landing exactly on the end of the last run is a valid boundary.
  const last = runs[runs.length - 1]
  if (last && offset === last.end) {
    return { node: last.node, offset: last.end - last.start }
  }
  return null
}

function rangeForSourceSpan(
  runs: SourceTextRun[],
  span: SourceSpan
): Range | null {
  const from = locateSourceOffset(runs, span.start)
  const to = locateSourceOffset(runs, span.end)
  if (!from || !to) return null

  const range = document.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  return range
}

function computeMatches(query: string, caseSensitive: boolean): SearchMatch[] {
  const root = getEditorRoot()
  if (!root || !query) return []

  // Read the very element `getValue()` derives Markdown from, so the offsets and
  // the ranges cannot describe two different pieces of DOM.
  const sourceElement = getVditorMode() === 'sv' ? getVditorEditorElement() : null
  if (sourceElement) {
    const source = getMarkdown()
    const { text, runs } = collectSourceTextRuns(sourceElement)
    if (sourceMatchesDomText(source, text)) {
      const mapped: SearchMatch[] = []
      for (const span of findSourceMatches(source, query, caseSensitive)) {
        const range = rangeForSourceSpan(runs, span)
        // A span can only fail to map when it reaches the synthetic trailing
        // newline, which a single-line query cannot contain.
        if (range) mapped.push({ range, source: span })
      }
      return mapped
    }
  }

  return findDomMatches(root, query, caseSensitive).map((range) => ({
    range,
    source: null,
  }))
}

function applyHighlights(found: SearchMatch[], activeIndex: number): void {
  const highlights =
    typeof CSS === 'undefined' ? undefined : (CSS as any).highlights
  const HighlightConstructor = (window as any).Highlight
  if (!highlights || !HighlightConstructor) return

  if (found.length > 0) {
    highlights.set(
      'vmd-search-result',
      new HighlightConstructor(...found.map((match) => match.range))
    )
  } else {
    highlights.delete('vmd-search-result')
  }

  if (activeIndex >= 0 && activeIndex < found.length) {
    highlights.set(
      'vmd-search-current',
      new HighlightConstructor(found[activeIndex].range)
    )
  } else {
    highlights.delete('vmd-search-current')
  }
}

function clearHighlights(): void {
  const highlights =
    typeof CSS === 'undefined' ? undefined : (CSS as any).highlights
  if (highlights) {
    highlights.delete('vmd-search-result')
    highlights.delete('vmd-search-current')
  }
  matches = []
  currentIndex = -1
}

function scrollToActive(found: SearchMatch[], index: number): void {
  if (index < 0 || index >= found.length) return
  try {
    found[index].range.startContainer.parentElement?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    })
  } catch (_) {
    // Ranges may be stale while Vditor replaces its editable DOM.
  }
}

function getSelectedEditorText(): string | undefined {
  const root = getEditorRoot()
  const selection = window.getSelection()
  if (!root || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return undefined
  }

  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return undefined
  }

  const text = selection.toString()
  return text || undefined
}

function getMarkdown(): string {
  return window.vditor?.getValue?.() || ''
}

function getEditorScrollTop(): number {
  const root = getEditorRoot()
  return root instanceof HTMLElement ? root.scrollTop : 0
}

function restoreEditorScrollTop(scrollTop: number): void {
  requestAnimationFrame(() => {
    const root = getEditorRoot()
    if (root instanceof HTMLElement) root.scrollTop = scrollTop
  })
}

function createButton(
  id: string,
  label: string,
  title: string
): HTMLButtonElement {
  const button = document.createElement('button')
  button.id = id
  button.type = 'button'
  button.textContent = label
  button.title = title
  button.setAttribute('aria-label', title)
  return button
}

export function initSearch() {
  const style = document.createElement('style')
  style.textContent = `
    ::highlight(vmd-search-result) {
      background-color: rgba(255, 216, 0, 0.38);
      color: inherit;
    }
    ::highlight(vmd-search-current) {
      background-color: rgba(255, 130, 0, 0.65);
      color: inherit;
    }
  `
  document.head.appendChild(style)

  const bar = document.createElement('div')
  bar.id = 'vmd-search-bar'
  bar.setAttribute('role', 'search')
  bar.setAttribute('aria-hidden', 'true')

  const findRow = document.createElement('div')
  findRow.className = 'vmd-search-row'

  const replaceToggle = createButton(
    'vmd-search-replace-toggle',
    '\u25be',
    t('toggleReplace')
  )
  replaceToggle.setAttribute('aria-controls', 'vmd-search-replace-row')
  replaceToggle.setAttribute('aria-expanded', 'false')

  const input = document.createElement('input')
  input.id = 'vmd-search-input'
  input.type = 'text'
  input.placeholder = t('findPlaceholder')
  input.spellcheck = false
  input.autocomplete = 'off'
  input.setAttribute('aria-label', t('findPlaceholder'))

  const countEl = document.createElement('span')
  countEl.id = 'vmd-search-count'
  countEl.setAttribute('aria-live', 'polite')

  const prevBtn = createButton(
    'vmd-search-prev',
    '\u25b2',
    t('previousMatch')
  )
  const nextBtn = createButton(
    'vmd-search-next',
    '\u25bc',
    t('nextMatch')
  )

  const caseLabel = document.createElement('label')
  caseLabel.id = 'vmd-search-case-label'
  caseLabel.title = t('matchCase')
  const caseCheckbox = document.createElement('input')
  caseCheckbox.id = 'vmd-search-case'
  caseCheckbox.type = 'checkbox'
  caseCheckbox.setAttribute('aria-label', t('matchCase'))
  caseLabel.append(caseCheckbox, document.createTextNode('Aa'))

  const closeBtn = createButton('vmd-search-close', '\u00d7', t('closeSearch'))
  findRow.append(
    replaceToggle,
    input,
    countEl,
    prevBtn,
    nextBtn,
    caseLabel,
    closeBtn
  )

  const replaceRow = document.createElement('div')
  replaceRow.id = 'vmd-search-replace-row'
  replaceRow.className = 'vmd-search-row vmd-search-replace-row'
  replaceRow.hidden = true

  const replaceIndent = document.createElement('span')
  replaceIndent.className = 'vmd-search-replace-indent'
  replaceIndent.setAttribute('aria-hidden', 'true')

  const replacementInput = document.createElement('input')
  replacementInput.id = 'vmd-search-replace-input'
  replacementInput.type = 'text'
  replacementInput.placeholder = t('replacePlaceholder')
  replacementInput.spellcheck = false
  replacementInput.autocomplete = 'off'
  replacementInput.setAttribute('aria-label', t('replacePlaceholder'))

  const replaceBtn = createButton(
    'vmd-search-replace',
    t('replace'),
    t('replaceCurrent')
  )
  const replaceAllBtn = createButton(
    'vmd-search-replace-all',
    t('replaceAll'),
    t('replaceAll')
  )
  replaceRow.append(replaceIndent, replacementInput, replaceBtn, replaceAllBtn)

  bar.append(findRow, replaceRow)
  document.body.appendChild(bar)

  let isOpen = false
  let replaceOpen = false
  let observedRoot: Element | null = null
  let rootObserver: MutationObserver | null = null
  let rebindTimer: ReturnType<typeof setTimeout> | null = null

  function activeSourceSpan(): SourceSpan | null {
    return matches[currentIndex]?.source || null
  }

  function updateActionState(): void {
    // Each button is enabled exactly when every span it would write to carries
    // a verified source offset, so the enabled state and the mutation are
    // derived from the same data instead of from a count that merely agrees.
    const hasQuery = input.value.length > 0
    replaceBtn.disabled = !hasQuery || !activeSourceSpan()
    replaceAllBtn.disabled =
      !hasQuery || matches.length === 0 || matches.some((match) => !match.source)
    prevBtn.disabled = matches.length === 0
    nextBtn.disabled = matches.length === 0
  }

  function updateCount(): void {
    const total = matches.length
    countEl.textContent =
      total > 0 ? `${currentIndex + 1}/${total}` : input.value ? '0/0' : ''
    countEl.classList.toggle(
      'vmd-search-count--nomatch',
      total === 0 && input.value.length > 0
    )
    updateActionState()
  }

  function refresh(
    pickIndex: (found: SearchMatch[]) => number,
    shouldScroll: boolean
  ): void {
    if (!input.value) {
      clearHighlights()
      updateCount()
      return
    }

    matches = computeMatches(input.value, caseCheckbox.checked)
    const preferred = matches.length > 0 ? pickIndex(matches) : -1
    // Keep the caller's position when it still points at a real match. Clamping
    // an out-of-range index to the last match would silently jump the active
    // highlight to the end of the document when an external update shrinks the
    // match list, so fall back to the first match instead.
    currentIndex =
      matches.length > 0
        ? preferred >= 0 && preferred < matches.length
          ? preferred
          : 0
        : -1
    applyHighlights(matches, currentIndex)
    if (shouldScroll && currentIndex >= 0) {
      scrollToActive(matches, currentIndex)
    }
    updateCount()
  }

  function runSearch(preferredIndex = 0, shouldScroll = true): void {
    refresh(() => preferredIndex, shouldScroll)
  }

  function scheduleSearch(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      if (isOpen) runSearch(Math.max(currentIndex, 0), false)
    }, 300)
  }

  function bindEditorRoot(): boolean {
    const root = getEditorRoot()
    if (root === observedRoot) return false

    rootObserver?.disconnect()
    rootObserver = null
    observedRoot = root
    if (!root) return true

    rootObserver = new MutationObserver(() => {
      if (isOpen) scheduleSearch()
    })
    rootObserver.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    return true
  }

  function rebind(): void {
    const changed = bindEditorRoot()
    if (changed && isOpen) runSearch(Math.max(currentIndex, 0), false)

    if (!observedRoot && !rebindTimer) {
      rebindTimer = setTimeout(() => {
        rebindTimer = null
        rebind()
      }, 250)
    }
  }

  function setReplaceOpen(open: boolean, focusInput = false): void {
    replaceOpen = open
    replaceRow.hidden = !open
    bar.classList.toggle('vmd-search-bar--replace-open', open)
    replaceToggle.setAttribute('aria-expanded', String(open))
    if (open && focusInput) replacementInput.focus()
  }

  function open(query?: string): void {
    if (query !== undefined) input.value = query
    isOpen = true
    rebind()
    bar.classList.add('vmd-search-bar--open')
    bar.setAttribute('aria-hidden', 'false')
    input.focus()
    input.select()
    runSearch()
  }

  function close(): void {
    isOpen = false
    bar.classList.remove('vmd-search-bar--open')
    bar.setAttribute('aria-hidden', 'true')
    clearHighlights()
    // updateCount() cannot clear the readout here: the query text is still in
    // the input, so its `input.value ? '0/0' : ''` branch would leave a stale
    // no-match count on a hidden bar and show it again on reopen.
    countEl.textContent = ''
    countEl.classList.remove('vmd-search-count--nomatch')
    updateActionState()
  }

  function goNext(): void {
    if (matches.length === 0) return
    currentIndex = (currentIndex + 1) % matches.length
    applyHighlights(matches, currentIndex)
    scrollToActive(matches, currentIndex)
    updateCount()
  }

  function goPrev(): void {
    if (matches.length === 0) return
    currentIndex = (currentIndex - 1 + matches.length) % matches.length
    applyHighlights(matches, currentIndex)
    scrollToActive(matches, currentIndex)
    updateCount()
  }

  function commitReplacement(after: string): boolean {
    const editor = window.vditor
    const before = editor?.getValue?.()
    if (!editor || typeof before !== 'string' || after === before) return false

    const scrollTop = getEditorScrollTop()
    editor.setValue(after)
    restoreEditorScrollTop(scrollTop)
    ;(window as any).__vmdCommitProgrammaticEdit?.()
    rebind()
    return true
  }

  /**
   * The span was recorded during the last search. Re-read the text it addresses
   * before writing through it: if the document changed in between, the offset
   * may now cover different content, and overwriting it blind is what turns a
   * stale index into silent corruption.
   */
  function sourceSpanHoldsQuery(source: string, span: SourceSpan): boolean {
    const found = source.slice(span.start, span.end)
    return caseCheckbox.checked
      ? found === input.value
      : found.toLowerCase() === input.value.toLowerCase()
  }

  function replaceCurrent(): void {
    const span = activeSourceSpan()
    const before = getMarkdown()
    if (!span || !sourceSpanHoldsQuery(before, span)) {
      runSearch(Math.max(currentIndex, 0), false)
      return
    }

    const replacement = replacementInput.value
    const after =
      before.slice(0, span.start) + replacement + before.slice(span.end)
    if (!commitReplacement(after)) return

    // Advance past the text just written rather than reusing the old ordinal.
    const nextOffset = span.start + replacement.length
    refresh((found) => {
      const index = found.findIndex(
        (match) => match.source && match.source.start >= nextOffset
      )
      return index >= 0 ? index : 0
    }, true)
  }

  function replaceAll(): void {
    const before = getMarkdown()
    const spans: SourceSpan[] = []
    for (const match of matches) {
      // Bail on the whole batch if any span no longer holds the query, instead
      // of writing a partially valid set of offsets.
      if (!match.source || !sourceSpanHoldsQuery(before, match.source)) {
        runSearch()
        return
      }
      spans.push(match.source)
    }
    if (spans.length === 0) {
      runSearch()
      return
    }

    // findSourceMatches walks forward past each match, so the spans are already
    // ascending and non-overlapping.
    const replacement = replacementInput.value
    let lastIndex = 0
    const parts: string[] = []
    for (const span of spans) {
      parts.push(before.slice(lastIndex, span.start), replacement)
      lastIndex = span.end
    }
    parts.push(before.slice(lastIndex))
    if (!commitReplacement(parts.join(''))) return
    runSearch()
  }

  input.addEventListener('input', () => runSearch())
  caseCheckbox.addEventListener('change', () => runSearch())

  input.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.shiftKey ? goPrev() : goNext()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })

  replacementInput.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) replaceAll()
      else replaceCurrent()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })

  replaceToggle.addEventListener('click', () => {
    setReplaceOpen(!replaceOpen, true)
  })
  prevBtn.addEventListener('click', goPrev)
  nextBtn.addEventListener('click', goNext)
  replaceBtn.addEventListener('click', replaceCurrent)
  replaceAllBtn.addEventListener('click', replaceAll)
  closeBtn.addEventListener('click', close)

  function openFromSelection(): void {
    open(getSelectedEditorText())
  }

  const onDocumentKeydown = (event: KeyboardEvent) => {
    const isPrimaryModifier = event.ctrlKey || event.metaKey
    if (
      isPrimaryModifier &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === 'f'
    ) {
      event.preventDefault()
      event.stopPropagation()
      openFromSelection()
    } else if (
      isOpen &&
      isPrimaryModifier &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === 'h'
    ) {
      event.preventDefault()
      event.stopPropagation()
      setReplaceOpen(!replaceOpen, true)
    }
  }
  document.addEventListener('keydown', onDocumentKeydown, true)

  rebind()

  return {
    open: openFromSelection,
    close,
    rebind,
    dispose() {
      if (rebindTimer) clearTimeout(rebindTimer)
      if (debounceTimer) clearTimeout(debounceTimer)
      rebindTimer = null
      debounceTimer = null
      rootObserver?.disconnect()
      rootObserver = null
      observedRoot = null
      document.removeEventListener('keydown', onDocumentKeydown, true)
      clearHighlights()
      bar.remove()
      style.remove()
    },
  }
}
