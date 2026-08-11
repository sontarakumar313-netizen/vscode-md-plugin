import {
  getVditorMode,
  getVditorSplitElements,
} from './vditor-adapter'

type Pane = 'source' | 'preview'

export interface SplitScrollSync {
  rebind(editor?: any): void
  dispose(): void
}

function maxScrollTop(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight)
}

function normalizedScrollTop(element: HTMLElement): number {
  const maximum = maxScrollTop(element)
  return maximum === 0 ? 0 : element.scrollTop / maximum
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(Math.max(value, lower), upper)
}

/**
 * Replaces Vditor's one-way SV scroll calculation with a bidirectional mapping
 * over each pane's scrollable range. The source listener is attached in capture
 * phase so Vditor's later target listener cannot overwrite the result.
 */
export function initSplitScrollSync(editor: any = window.vditor): SplitScrollSync {
  let currentEditor: any = null
  let source: HTMLElement | null = null
  let preview: HTMLElement | null = null
  let previewContent: HTMLElement | null = null
  let syncFrame = 0
  let syncTimer: ReturnType<typeof setTimeout> | null = null
  let reconcileFrame = 0
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null
  let expectedSourceTop: number | null = null
  let expectedPreviewTop: number | null = null
  let expectedSourceClearFrame = 0
  let expectedSourceClearTimer: ReturnType<typeof setTimeout> | null = null
  let expectedPreviewClearFrame = 0
  let expectedPreviewClearTimer: ReturnType<typeof setTimeout> | null = null
  let pendingPane: Pane | null = null
  let lastUserPane: Pane | null = null
  let contentObserver: MutationObserver | null = null
  let resizeObserver: ResizeObserver | null = null

  const isActive = (): boolean => {
    return !!(
      currentEditor &&
      source &&
      preview &&
      source.isConnected &&
      preview.isConnected &&
      getVditorMode(currentEditor) === 'sv' &&
      preview.style.display !== 'none' &&
      source.clientHeight > 0 &&
      preview.clientHeight > 0
    )
  }

  const clearExpected = (pane: Pane, expected: number): void => {
    if (pane === 'source') {
      if (expectedSourceTop === expected) expectedSourceTop = null
      if (expectedSourceClearFrame) {
        cancelAnimationFrame(expectedSourceClearFrame)
      }
      if (expectedSourceClearTimer) {
        clearTimeout(expectedSourceClearTimer)
      }
      expectedSourceClearFrame = 0
      expectedSourceClearTimer = null
    } else {
      if (expectedPreviewTop === expected) expectedPreviewTop = null
      if (expectedPreviewClearFrame) {
        cancelAnimationFrame(expectedPreviewClearFrame)
      }
      if (expectedPreviewClearTimer) {
        clearTimeout(expectedPreviewClearTimer)
      }
      expectedPreviewClearFrame = 0
      expectedPreviewClearTimer = null
    }
  }

  const rememberExpected = (pane: Pane, expected: number): void => {
    if (pane === 'source') {
      expectedSourceTop = expected
      if (expectedSourceClearFrame) {
        cancelAnimationFrame(expectedSourceClearFrame)
      }
      if (expectedSourceClearTimer) {
        clearTimeout(expectedSourceClearTimer)
      }
      expectedSourceClearFrame = requestAnimationFrame(() => {
        clearExpected('source', expected)
      })
      expectedSourceClearTimer = setTimeout(() => {
        clearExpected('source', expected)
      }, 34)
      return
    }

    expectedPreviewTop = expected
    if (expectedPreviewClearFrame) {
      cancelAnimationFrame(expectedPreviewClearFrame)
    }
    if (expectedPreviewClearTimer) {
      clearTimeout(expectedPreviewClearTimer)
    }
    expectedPreviewClearFrame = requestAnimationFrame(() => {
      clearExpected('preview', expected)
    })
    expectedPreviewClearTimer = setTimeout(() => {
      clearExpected('preview', expected)
    }, 34)
  }

  const consumesExpectedScroll = (pane: Pane, element: HTMLElement): boolean => {
    const expected = pane === 'source' ? expectedSourceTop : expectedPreviewTop
    if (expected === null) return false
    // Only consume the reservation on the event that actually lands on it.
    // Clearing first meant an intermediate scroll event -- one fired while the
    // pane was still settling, or after a reflow clamped the target -- burned
    // the reservation, so the event that did land read as user input and was
    // echoed straight back to the other pane. The rAF and 34ms timers still
    // bound how long an unmatched reservation can suppress a real scroll.
    if (Math.abs(element.scrollTop - expected) > 1) return false

    clearExpected(pane, expected)
    return true
  }

  const syncFrom = (pane: Pane): void => {
    if (!isActive() || !source || !preview) return

    const from = pane === 'source' ? source : preview
    const to = pane === 'source' ? preview : source
    const toPane: Pane = pane === 'source' ? 'preview' : 'source'
    const targetTop = clamp(
      normalizedScrollTop(from) * maxScrollTop(to),
      0,
      maxScrollTop(to)
    )

    if (Math.abs(to.scrollTop - targetTop) <= 1) return

    rememberExpected(toPane, targetTop)
    to.scrollTop = targetTop
  }

  const scheduleSync = (pane: Pane): void => {
    const element = pane === 'source' ? source : preview
    if (!element || consumesExpectedScroll(pane, element)) return

    lastUserPane = pane
    pendingPane = pane
    if (syncFrame || syncTimer) return

    const flush = () => {
      if (syncFrame) cancelAnimationFrame(syncFrame)
      if (syncTimer) clearTimeout(syncTimer)
      syncFrame = 0
      syncTimer = null
      const activePane = pendingPane
      pendingPane = null
      if (activePane) syncFrom(activePane)
    }
    syncFrame = requestAnimationFrame(flush)
    // Headless Chromium and inactive VS Code Webviews may defer animation
    // frames. The timeout keeps scroll synchronization responsive there too.
    syncTimer = setTimeout(flush, 34)
  }

  const scheduleReconcile = (): void => {
    if (!lastUserPane || reconcileFrame || reconcileTimer) return

    const flush = () => {
      if (reconcileFrame) cancelAnimationFrame(reconcileFrame)
      if (reconcileTimer) clearTimeout(reconcileTimer)
      reconcileFrame = 0
      reconcileTimer = null
      if (!pendingPane && lastUserPane) syncFrom(lastUserPane)
    }
    reconcileFrame = requestAnimationFrame(flush)
    reconcileTimer = setTimeout(flush, 34)
  }

  const onSourceScroll = (event: Event): void => {
    if (!isActive()) return
    // Vditor registered a bubbling source listener during construction. This
    // target-capture listener runs first and replaces its discontinuous formula.
    event.stopImmediatePropagation()
    scheduleSync('source')
  }

  const onPreviewScroll = (): void => {
    if (!isActive()) return
    scheduleSync('preview')
  }

  const teardown = (): void => {
    if (syncFrame) cancelAnimationFrame(syncFrame)
    if (syncTimer) clearTimeout(syncTimer)
    if (reconcileFrame) cancelAnimationFrame(reconcileFrame)
    if (reconcileTimer) clearTimeout(reconcileTimer)
    if (expectedSourceClearFrame) cancelAnimationFrame(expectedSourceClearFrame)
    if (expectedSourceClearTimer) clearTimeout(expectedSourceClearTimer)
    if (expectedPreviewClearFrame) cancelAnimationFrame(expectedPreviewClearFrame)
    if (expectedPreviewClearTimer) clearTimeout(expectedPreviewClearTimer)
    syncFrame = 0
    syncTimer = null
    reconcileFrame = 0
    reconcileTimer = null
    expectedSourceClearFrame = 0
    expectedSourceClearTimer = null
    expectedPreviewClearFrame = 0
    expectedPreviewClearTimer = null
    source?.removeEventListener('scroll', onSourceScroll, true)
    preview?.removeEventListener('scroll', onPreviewScroll)
    contentObserver?.disconnect()
    resizeObserver?.disconnect()
    contentObserver = null
    resizeObserver = null
    source = null
    preview = null
    previewContent = null
    expectedSourceTop = null
    expectedPreviewTop = null
    pendingPane = null
    lastUserPane = null
  }

  const rebind = (nextEditor: any = window.vditor): void => {
    if (nextEditor === currentEditor && source?.isConnected && preview?.isConnected) {
      return
    }

    teardown()
    currentEditor = nextEditor
    const panes = getVditorSplitElements(currentEditor)
    if (!panes) return

    source = panes.source
    preview = panes.preview
    previewContent = panes.previewContent
    source.addEventListener('scroll', onSourceScroll, true)
    preview.addEventListener('scroll', onPreviewScroll, { passive: true })

    contentObserver = new MutationObserver(scheduleReconcile)
    contentObserver.observe(source, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    if (previewContent) {
      contentObserver.observe(previewContent, {
        childList: true,
        subtree: true,
        characterData: true,
      })
    }

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(scheduleReconcile)
      resizeObserver.observe(source)
      resizeObserver.observe(preview)
      if (previewContent) resizeObserver.observe(previewContent)
    }
  }

  const dispose = (): void => {
    if (syncFrame) cancelAnimationFrame(syncFrame)
    if (syncTimer) clearTimeout(syncTimer)
    if (reconcileFrame) cancelAnimationFrame(reconcileFrame)
    if (reconcileTimer) clearTimeout(reconcileTimer)
    if (expectedSourceClearFrame) cancelAnimationFrame(expectedSourceClearFrame)
    if (expectedSourceClearTimer) clearTimeout(expectedSourceClearTimer)
    if (expectedPreviewClearFrame) cancelAnimationFrame(expectedPreviewClearFrame)
    if (expectedPreviewClearTimer) clearTimeout(expectedPreviewClearTimer)
    syncFrame = 0
    syncTimer = null
    reconcileFrame = 0
    reconcileTimer = null
    expectedSourceClearFrame = 0
    expectedSourceClearTimer = null
    expectedPreviewClearFrame = 0
    expectedPreviewClearTimer = null
    teardown()
    currentEditor = null
  }

  rebind(editor)
  return { rebind, dispose }
}
