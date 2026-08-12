/**
 * wysiwyg-code-block.ts
 *
 * Enhances WYSIWYG code blocks:
 *  1. Auto-closes open source panels when the user clicks outside the editor.
 *  2. Injects a language dropdown + always-visible copy button bar into each
 *     rendered code block's <pre>.
 */

const COMMON_LANGUAGES = [
  'javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'csharp',
  'go', 'rust', 'html', 'css', 'json', 'yaml', 'bash', 'shell',
  'sql', 'xml', 'php', 'ruby', 'swift', 'kotlin', 'r', 'scala',
  'diff', 'dockerfile', 'makefile', 'toml', 'ini', 'markdown',
]

/** Special preview languages — skip the language bar for these. */
const SPECIAL_LANGS = new Set([
  'mermaid', 'flowchart', 'echarts', 'mindmap', 'plantuml',
  'markmap', 'abc', 'graphviz', 'math', 'smiles',
])

const LANG_WRAP_CLASS = 'vmd-code-lang-wrap'

function getWysiwygRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.vditor-wysiwyg .vditor-reset')
}

/** Closes all open code/formula source panels, optionally excluding one block. */
export function closeOpenSourcePanels(exceptBlock?: Element | null): void {
  const root = getWysiwygRoot()
  if (!root) return
  root.querySelectorAll<HTMLElement>('.vditor-wysiwyg__preview').forEach((preview) => {
    const source = preview.previousElementSibling as HTMLElement | null
    if (!source || source.style.display === 'none') return
    const block = preview.closest('.vditor-wysiwyg__block')
    if (exceptBlock && block === exceptBlock) return
    source.style.display = 'none'
  })
}

/**
 * Installs a document-level mousedown listener (capture phase) that closes any
 * open code/formula source panels whenever the click lands outside the WYSIWYG
 * editing area. Vditor's own handler only fires for clicks inside the editor.
 */
function installAutoCloseSourcePanels(): void {
  if ((window as any).__vmdAutoClosePanels) return
  ;(window as any).__vmdAutoClosePanels = true

  document.addEventListener(
    'mousedown',
    (event) => {
      const target = event.target
      if (!(target instanceof Node)) return
      const root = getWysiwygRoot()
      if (!root) return
      // Clicks inside the editor are handled by Vditor's own highlightToolbarWYSIWYG.
      if (root.contains(target)) return
      closeOpenSourcePanels()
    },
    true
  )
}

function getLangFromClass(className: string): string {
  const m = className.match(/\blanguage-(\S+)/)
  return m ? m[1] : ''
}

/**
 * Re-applies hljs syntax highlighting in-place and returns the plain-text
 * content captured before the highlight (needed for the copy textarea).
 */
function applyHighlight(codeEl: HTMLElement, lang: string): string {
  const rawText = codeEl.textContent || ''
  const hljs: any = (window as any).hljs
  if (hljs) {
    const safeLang = hljs.getLanguage(lang) ? lang : 'plaintext'
    codeEl.innerHTML = hljs.highlight(rawText, {
      language: safeLang,
      ignoreIllegals: true,
    }).value
  }
  // Normalize class list: drop any existing language-* / hljs tokens, then re-add.
  const base = codeEl.className
    .replace(/\bhljs\b/g, '')
    .replace(/\blanguage-\S+/g, '')
    .trim()
  codeEl.className = [base, lang ? `language-${lang}` : '', hljs ? 'hljs' : '']
    .filter(Boolean)
    .join(' ')
  return rawText
}

/**
 * Injects (or repairs) the language-select + copy-button toolbar inside the
 * <pre> element of a rendered code block's preview div.
 *
 * DOM structure after decoration:
 *   <div class="vditor-wysiwyg__preview">
 *     <pre>
 *       <div class="vmd-code-lang-wrap">           ← new
 *         <select class="vmd-code-lang-select">…   ← new
 *         <div class="vditor-copy">…               ← moved here from its original spot
 *       <code class="language-js hljs">…           ← untouched
 *       <span style="position:absolute">…          ← Vditor ZWSP, untouched
 *
 * If the wrap already exists but .vditor-copy has not yet been moved into it
 * (because codeRender ran after our first decoration pass), we move it on the
 * next observer tick.
 */
function decorateCodeBlock(previewDiv: HTMLElement): void {
  const preEl = previewDiv.querySelector<HTMLElement>('pre')
  if (!preEl) return
  const codeEl = preEl.querySelector<HTMLElement>('code')
  if (!codeEl) return

  const lang = getLangFromClass(codeEl.className)
  if (SPECIAL_LANGS.has(lang)) return

  const block = previewDiv.closest<HTMLElement>('.vditor-wysiwyg__block')
  if (!block) return

  // Enable inline-edit mode: CSS forces the source <pre> always visible and
  // visually reorders it below the language bar from the preview div.
  block.classList.add('vmd-code-inline-edit')

  // The hidden source <code> element whose class drives serialization.
  const sourceCode = block.querySelector<HTMLElement>(
    ':scope > .vditor-wysiwyg__pre code'
  )

  const existingWrap = preEl.querySelector<HTMLElement>(`:scope > .${LANG_WRAP_CLASS}`)
  const copyDiv = preEl.querySelector<HTMLElement>(':scope > .vditor-copy')

  // If the wrap already exists, just adopt any freshly-added copy button.
  if (existingWrap) {
    if (copyDiv && !existingWrap.contains(copyDiv)) {
      existingWrap.appendChild(copyDiv)
    }
    return
  }

  // Can't set up the bar without the copy button yet — observer will retry.
  if (!copyDiv) return

  // Build the language select.
  const allLangs: string[] = []
  if (lang && !COMMON_LANGUAGES.includes(lang)) allLangs.push(lang)
  allLangs.push(...COMMON_LANGUAGES)

  const select = document.createElement('select')
  select.className = 'vmd-code-lang-select'
  select.title = 'Language'
  select.setAttribute('contenteditable', 'false')

  const blankOpt = document.createElement('option')
  blankOpt.value = ''
  blankOpt.textContent = '—'
  if (!lang) blankOpt.selected = true
  select.appendChild(blankOpt)

  for (const l of allLangs) {
    const opt = document.createElement('option')
    opt.value = l
    opt.textContent = l
    if (l === lang) opt.selected = true
    select.appendChild(opt)
  }

  // Capture textarea reference while copy button is still inside <pre>.
  const textarea = copyDiv.querySelector<HTMLTextAreaElement>('textarea')

  // Keep the copy button's textarea in sync with the editable source text.
  // (The source may have been modified since codeRender last set the textarea.)
  if (textarea && sourceCode) {
    copyDiv.addEventListener('mousedown', () => {
      textarea.value = sourceCode.textContent || ''
    })
  }

  // Prevent mousedown from reaching Vditor and moving the caret.
  select.addEventListener('mousedown', (e) => e.stopPropagation())

  select.addEventListener('change', (e) => {
    e.stopPropagation()
    const newLang = select.value
    if (sourceCode) {
      sourceCode.className = newLang ? `language-${newLang}` : ''
    }
    const rawText = applyHighlight(codeEl, newLang)
    if (textarea) textarea.value = rawText
    ;(window as any).__vmdCommitProgrammaticEdit?.()
  })

  // Assemble: wrap = [select] [copy button].
  const wrap = document.createElement('div')
  wrap.className = LANG_WRAP_CLASS
  wrap.setAttribute('contenteditable', 'false')
  wrap.appendChild(select)
  wrap.appendChild(copyDiv) // moves .vditor-copy out of its original position

  preEl.insertBefore(wrap, preEl.firstChild)
}

/** Main entry point — call once from main.ts `after()`. */
export function initWysiwygCodeBlocks(): { rebind(): void; dispose(): void } {
  let root: HTMLElement | null = null
  let observer: MutationObserver | null = null
  let refreshQueued = false

  installAutoCloseSourcePanels()

  function refresh(): void {
    refreshQueued = false
    if (!root) return
    root
      .querySelectorAll<HTMLElement>(
        '.vditor-wysiwyg__block[data-type="code-block"] > .vditor-wysiwyg__preview'
      )
      .forEach(decorateCodeBlock)
  }

  function queueRefresh(): void {
    if (refreshQueued) return
    refreshQueued = true
    queueMicrotask(refresh)
  }

  function rebind(): void {
    const nextRoot = getWysiwygRoot()
    if (nextRoot === root) {
      if (root) queueRefresh()
      return
    }
    observer?.disconnect()
    observer = null
    root = nextRoot
    if (!root) return
    observer = new MutationObserver(queueRefresh)
    observer.observe(root, { childList: true, subtree: true })
    queueRefresh()
  }

  rebind()

  return {
    rebind,
    dispose() {
      observer?.disconnect()
      observer = null
      root = null
    },
  }
}
