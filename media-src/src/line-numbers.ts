import { getVditorMode } from './vditor-adapter'
import type { VditorMode } from './vditor-adapter'

const GUTTER_ID = 'vmd-line-number-gutter'

function getBlockStartLines(source: string): number[] {
  const lines = source.split('\n')
  const starts: number[] = []
  const fence = '```'
  const heading = /^#{1,6} /
  const horizontalRule = /^(---|[*]{3}|___)$/
  const listItem = /^[-*+] /
  const orderedListItem = /^[0-9]+[.)] /
  const indented = /^ +[^ ]/
  let index = 0

  const isBlock = (line: string) =>
    heading.test(line) ||
    listItem.test(line) ||
    orderedListItem.test(line) ||
    line.startsWith(fence) ||
    line.startsWith('|') ||
    line.startsWith('>') ||
    horizontalRule.test(line)

  if (lines.length > 0 && lines[0].trim() === '---') {
    starts.push(1)
    index = 1
    while (index < lines.length && lines[index].trim() !== '---') index += 1
    if (index < lines.length) index += 1
  }

  while (index < lines.length) {
    if (lines[index].trim() === '') {
      index += 1
      continue
    }

    starts.push(index + 1)
    const trimmed = lines[index].trim()
    if (heading.test(trimmed) || horizontalRule.test(trimmed)) {
      index += 1
    } else if (trimmed.startsWith(fence)) {
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith(fence)) {
        index += 1
      }
      if (index < lines.length) index += 1
    } else if (trimmed.startsWith('|')) {
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        index += 1
      }
    } else if (trimmed.startsWith('>')) {
      while (
        index < lines.length &&
        lines[index].trim() !== '' &&
        lines[index].trimStart().startsWith('>')
      ) {
        index += 1
      }
    } else if (listItem.test(trimmed) || orderedListItem.test(trimmed)) {
      while (index < lines.length) {
        if (lines[index].trim() !== '') {
          index += 1
          continue
        }

        let next = index + 1
        while (next < lines.length && lines[next].trim() === '') next += 1
        if (
          next < lines.length &&
          (listItem.test(lines[next].trim()) ||
            orderedListItem.test(lines[next].trim()) ||
            indented.test(lines[next]))
        ) {
          index = next
        } else {
          break
        }
      }
    } else {
      index += 1
      while (index < lines.length && lines[index].trim() !== '') {
        if (isBlock(lines[index].trim())) break
        index += 1
      }
    }
  }

  return starts
}

type ActiveEditor = {
  mode: VditorMode
  editor: HTMLElement
  reset: HTMLElement
}

function getActiveEditor(): ActiveEditor | null {
  const candidates: Record<VditorMode, ActiveEditor | null> = {
    wysiwyg: (() => {
      const editor = document.querySelector<HTMLElement>('.vditor-wysiwyg')
      const reset = document.querySelector<HTMLElement>(
        '.vditor-wysiwyg .vditor-reset'
      )
      return editor && reset ? { mode: 'wysiwyg', editor, reset } : null
    })(),
    sv: (() => {
      const reset = document.querySelector<HTMLElement>('.vditor-sv')
      return reset ? { mode: 'sv', editor: reset, reset } : null
    })(),
  }

  const currentMode = getVditorMode()
  if (currentMode && candidates[currentMode]) return candidates[currentMode]

  return (
    (Object.keys(candidates) as VditorMode[])
      .map((mode) => candidates[mode])
      .find((candidate) => candidate && candidate.editor.getClientRects().length > 0) ||
    null
  )
}

function createLineNumber(value: number, top: number): HTMLElement {
  const line = document.createElement('div')
  line.className = 'vmd-line-number'
  line.style.top = `${top}px`
  line.textContent = String(value)
  return line
}

function getCaretRectAfter(element: Element): DOMRect | null {
  const range = document.createRange()
  range.setStartAfter(element)
  range.collapse(true)
  const rect = range.getClientRects().item(0) || range.getBoundingClientRect()
  return rect.height > 0 ? rect : null
}

export function initLineNumbers() {
  const gutter = document.createElement('div')
  gutter.id = GUTTER_ID
  document.body.appendChild(gutter)

  let enabled = true
  let frame: number | null = null
  let mutationObserver: MutationObserver | null = null
  let resizeObserver: ResizeObserver | null = null
  let cachedSource = ''
  let cachedStarts: number[] = []

  const updateToolbarState = () => {
    const button = document.querySelector<HTMLElement>(
      '.vditor-toolbar [data-type="line-numbers"]'
    )
    if (!button) return
    button.style.removeProperty('opacity')
    button.classList.toggle('vditor-menu--current', enabled)
    button.setAttribute('aria-pressed', enabled ? 'true' : 'false')
  }

  const renderSourceLines = (
    reset: HTMLElement,
    editorRect: DOMRect,
    source: string
  ) => {
    const computed = window.getComputedStyle(reset)
    const fontSize = Number.parseFloat(computed.fontSize) || 16
    const parsedLineHeight = Number.parseFloat(computed.lineHeight)
    const lineHeight = Number.isNaN(parsedLineHeight)
      ? fontSize * 1.5
      : parsedLineHeight
    const paddingTop = Number.parseFloat(computed.paddingTop) || 0
    const newlineMarkers = Array.from(
      reset.querySelectorAll<HTMLElement>('[data-type="newline"]')
    )
    const lineCount = source.split('\n').length
    const fragment = document.createDocumentFragment()
    let top = paddingTop - reset.scrollTop

    for (let index = 0; index < lineCount; index += 1) {
      if (index > 0) {
        const marker = newlineMarkers[index - 1]
        const caretRect = marker ? getCaretRectAfter(marker) : null
        if (caretRect) {
          top = caretRect.top - editorRect.top
        } else if (marker) {
          top = marker.getBoundingClientRect().bottom - editorRect.top
        } else {
          top += lineHeight
        }
      }

      if (top + lineHeight >= 0 && top <= editorRect.height) {
        fragment.appendChild(
          createLineNumber(index + 1, top + lineHeight / 2 - 5)
        )
      }
    }

    gutter.appendChild(fragment)
  }

  const renderBlockLines = (
    reset: HTMLElement,
    editorRect: DOMRect,
    source: string
  ) => {
    const blocks = Array.from(reset.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element.offsetHeight > 0
    )

    if (source !== cachedSource) {
      cachedSource = source
      cachedStarts = getBlockStartLines(source)
    }

    const fragment = document.createDocumentFragment()
    blocks.forEach((block, index) => {
      const rect = block.getBoundingClientRect()
      const top = rect.top - editorRect.top
      if (top + rect.height < 0 || top > editorRect.height) return

      const computed = window.getComputedStyle(block)
      const fontSize = Number.parseFloat(computed.fontSize) || 16
      const parsedLineHeight = Number.parseFloat(computed.lineHeight)
      const lineHeight = Number.isNaN(parsedLineHeight)
        ? fontSize * 1.6
        : parsedLineHeight
      fragment.appendChild(
        createLineNumber(
          cachedStarts[index] || index + 1,
          top + lineHeight / 2 - 5
        )
      )
    })

    gutter.appendChild(fragment)
  }

  const render = () => {
    frame = null
    if (!enabled) return

    const active = getActiveEditor()
    if (!active || !active.reset.isConnected || !active.editor.isConnected) {
      gutter.innerHTML = ''
      return
    }

    const editorRect = active.editor.getBoundingClientRect()
    if (editorRect.width === 0 || editorRect.height === 0) {
      gutter.innerHTML = ''
      return
    }

    gutter.style.left = `${editorRect.left}px`
    gutter.style.top = `${editorRect.top}px`
    gutter.style.height = `${editorRect.height}px`
    gutter.innerHTML = ''

    const source = window.vditor?.getValue?.() || ''
    if (active.mode === 'sv') {
      renderSourceLines(active.reset, editorRect, source)
    } else {
      renderBlockLines(active.reset, editorRect, source)
    }
  }

  const schedule = () => {
    if (!enabled || frame !== null) return
    frame = requestAnimationFrame(render)
  }

  const rebind = () => {
    mutationObserver?.disconnect()
    resizeObserver?.disconnect()
    cachedSource = ''
    cachedStarts = []

    const content = document.querySelector<HTMLElement>('.vditor-content')
    if (content) {
      mutationObserver = new MutationObserver(schedule)
      mutationObserver.observe(content, {
        attributes: true,
        attributeFilter: ['class', 'style'],
        childList: true,
        subtree: true,
        characterData: true,
      })

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(schedule)
        resizeObserver.observe(content)
        content
          .querySelectorAll<HTMLElement>(
            '.vditor-wysiwyg, .vditor-sv, .vditor-wysiwyg .vditor-reset'
          )
          .forEach((element) => resizeObserver?.observe(element))
      }
    }

    document.body.classList.toggle('vmd-line-numbers-enabled', enabled)
    updateToolbarState()
    schedule()
  }

  const toggle = () => {
    enabled = !enabled
    document.body.classList.toggle('vmd-line-numbers-enabled', enabled)
    updateToolbarState()
    if (enabled) schedule()
  }

  const onScroll = () => schedule()
  const onResize = () => schedule()
  document.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onResize)
  rebind()

  return {
    toggle,
    rebind,
    refresh: schedule,
    dispose() {
      if (frame !== null) cancelAnimationFrame(frame)
      mutationObserver?.disconnect()
      resizeObserver?.disconnect()
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      gutter.remove()
    },
  }
}
