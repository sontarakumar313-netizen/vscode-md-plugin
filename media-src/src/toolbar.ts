import {
	countTextOccurrences,
	findTextOccurrence,
	getEditorSelectionContext,
	getVisibleTextBefore,
	getVisibleTextBeforeElement,
	preserveEditorSelectionForToolbar,
} from './caret-anchor'
import { t } from './lang'
import { confirm, saveVditorOptions } from './utils'
import {
	getVditorEditorElement,
	getVditorMode,
} from './vditor-adapter'
import type { VditorMode } from './vditor-adapter'

const outlineIcon = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 1v22M4 6h1.2M4 11h1.2M4 16h1.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
const lineNumbersIcon = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M9 3h14M9 12h14M9 21h14M1 3h2v6M1 9h3M4 22H1c0-1.2 3-3 3-4.5S2.5 15 1 15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
// These follow MathType's Word toolbar idea: inline math sits in a text line,
// while display math is set apart between two paragraph rules. The shape stays
// an SVG so it uses the same 15px box as every other toolbar icon.
const mathBlockIcon = '<svg class="vmd-math-toolbar-icon vmd-math-toolbar-icon--display" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M1 1.5h22M1 22.5h22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M13 4H5l5 8-5 8h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 6h7M16 12h5M16 18h7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
const mathInlineIcon = '<svg class="vmd-math-toolbar-icon vmd-math-toolbar-icon--inline" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M1 6h2M1 18h2M21 6h2M21 18h2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M13 2H5l5 10-5 10h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 6h7M16 12h5M16 18h7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
const detailsIcon = '<svg class="vmd-details-toolbar-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M4 6h10M4 12h10M4 18h10M17 8l5 4-5 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const editingModeIcon = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 18.5h3.5L18 9l-3-3-9.5 9.5L5 18.5zm8.5-11 3 3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'

// insertMD writes raw Markdown, so a `$` inside the selection would close the
// math delimiter early and turn `a$b` into the broken `$a$b$`. Normalize every
// dollar to the LaTeX literal `\$`; the optional leading backslash in the
// pattern keeps an already-escaped `$` from growing a second one.
// Backslashes are deliberately left alone so a selected `\frac{1}{2}` survives.
function escapeMathDollars(source: string): string {
	return source.replace(/\\?\$/g, () => '\\$')
}

// Inline math has to stay on one line to parse, so a multi-line selection
// collapses to spaces instead of silently producing unrenderable output.
function toInlineMath(selected: string): string {
	const body = escapeMathDollars(selected).replace(/\s+/g, ' ').trim()
	return body ? `$${body}$` : '$x$'
}

function toMathBlock(selected: string): string {
	const body = escapeMathDollars(selected).trim()
	return body ? `$$\n${body}\n$$` : '$$\nx\n$$'
}

function toDetailsBlock(selected: string): string {
	const body = selected.trim()
	return `<details>\n<summary>${t('detailsSummary')}</summary>\n\n${
		body || t('detailsContent')
	}\n\n</details>`
}

function expandMarkdownSelection(
	source: string,
	start: number,
	end: number
): { start: number; end: number } {
	// WYSIWYG selections omit Markdown emphasis markers. Keep matching pairs in
	// the details body, otherwise **text** would become **<details>...</details>**.
	let changed = true
	while (changed) {
		changed = false
		for (const marker of ['**', '__', '~~', '`', '*', '_']) {
			if (
				start >= marker.length &&
				source.slice(start - marker.length, start) === marker &&
				source.slice(end, end + marker.length) === marker
			) {
				start -= marker.length
				end += marker.length
				changed = true
			}
		}
	}

	const lineStart = source.lastIndexOf('\n', start - 1) + 1
	const linePrefix = source.slice(lineStart, start)
	if (/^\s*(?:#{1,6}\s+|>\s+|(?:[-+*]|\d+[.)])\s+)/.test(linePrefix)) {
		start = lineStart
		const lineEnd = source.indexOf('\n', end)
		end = lineEnd < 0 ? source.length : lineEnd
	}

	// A selected link label should remain a link inside the folded content.
	if (source[start - 1] === '[' && source.slice(end, end + 2) === '](') {
		const close = source.indexOf(')', end + 2)
		if (close >= 0) {
			start -= 1
			end = close + 1
		}
	}
	return { start, end }
}

function gapBeforeBlock(value: string): string {
	if (!value) return ''
	if (value.endsWith('\n\n')) return ''
	return value.endsWith('\n') ? '\n' : '\n\n'
}

function gapAfterBlock(value: string): string {
	if (!value) return '\n'
	if (value.startsWith('\n\n')) return ''
	return value.startsWith('\n') ? '\n' : '\n\n'
}

function insertDetails(editor: any): void {
	const source = String(editor.getValue?.() || '')
	const context = getEditorSelectionContext(editor)
	const rawSelection = String(
		editor.getSelection?.() || context?.range.toString() || ''
	)
	const selected = rawSelection.trim()

	if (selected) {
		const visibleBefore = getVisibleTextBefore(context)
		const occurrence = countTextOccurrences(visibleBefore, selected)
		let selectedStart = findTextOccurrence(source, selected, occurrence)
		if (selectedStart < 0) selectedStart = source.indexOf(selected)

		if (selectedStart >= 0) {
			const selectedRange = expandMarkdownSelection(
				source,
				selectedStart,
				selectedStart + selected.length
			)
			const before = source.slice(0, selectedRange.start)
			const after = source.slice(selectedRange.end)
			const block = toDetailsBlock(
				source.slice(selectedRange.start, selectedRange.end)
			)
			editor.setValue(
				`${before}${gapBeforeBlock(before)}${block}${gapAfterBlock(after)}${after}`
			)
			return
		}
	}

	const block = toDetailsBlock('')
	if (!context) {
		// Keep the source unchanged, including trailing whitespace, when no DOM
		// caret is available (for example immediately after a mode rebuild).
		editor.setValue(`${source}${gapBeforeBlock(source)}${block}\n`)
		return
	}

	const visibleBefore = getVisibleTextBefore(context)
	let insertionOffset = -1
	if (context.mode === 'sv' && source.startsWith(visibleBefore)) {
		insertionOffset = visibleBefore.length
	} else {
		const node =
			context.range.startContainer.nodeType === Node.ELEMENT_NODE
				? (context.range.startContainer as Element)
				: context.range.startContainer.parentElement
		const blockElement = node?.closest(
			'p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, [data-block]'
		)
		const blockText = blockElement?.textContent?.trim() || ''
		if (blockElement && blockText) {
			// Count complete blocks before the caret, not the text before the
			// caret itself. At the end of a duplicated block the latter includes
			// the current occurrence and would select the following duplicate.
			const beforeBlock = getVisibleTextBeforeElement(context, blockElement)
			const occurrence = countTextOccurrences(beforeBlock, blockText)
			insertionOffset = findTextOccurrence(source, blockText, occurrence)
		}
	}

	if (insertionOffset < 0) {
		editor.setValue(`${source}${gapBeforeBlock(source)}${block}\n`)
		return
	}

	const lineStart = source.lastIndexOf('\n', insertionOffset - 1) + 1
	const before = source.slice(0, lineStart)
	const after = source.slice(lineStart)
	editor.setValue(`${before}${block}${gapAfterBlock(after)}${after}`)
}

const selectionPreserverToolbars = new WeakSet<HTMLElement>()

/** Capture the caret before a toolbar button takes browser focus. */
export function installToolbarSelectionPreserver(editor: any): void {
	const toolbarElement = editor?.vditor?.toolbar?.element
	if (
		!(toolbarElement instanceof HTMLElement) ||
		selectionPreserverToolbars.has(toolbarElement)
	) {
		return
	}

	toolbarElement.addEventListener(
		'pointerdown',
		() => preserveEditorSelectionForToolbar(editor),
		true
	)
	selectionPreserverToolbars.add(toolbarElement)
}

async function copyToClipboard(content: string, label: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(content)
		vscode.postMessage({ command: 'info', content: `Copy ${label} successfully!` })
	} catch (error) {
		vscode.postMessage({ command: 'error', content: `Copy ${label} failed! ${error.message}` })
	}
}

const MODE_BUTTONS: Array<{ name: string; mode: VditorMode }> = [
	{ name: 'vmd-mode-wysiwyg', mode: 'wysiwyg' },
	{ name: 'vmd-mode-sv', mode: 'sv' },
]

export function syncEditorModeToolbar(editor: any = window.vditor): void {
	const current = getVditorMode(editor)
	for (const { name, mode } of MODE_BUTTONS) {
		const button = document.querySelector<HTMLElement>(
			`.vditor-toolbar [data-type="${name}"]`
		)
		if (!button) continue
		const active = current === mode
		button.classList.toggle('vditor-menu--current', active)
		button.setAttribute('aria-pressed', String(active))
	}
}

function refreshModeDependentFeatures(): void {
	;(window as any).__vmdDetails?.rebind?.()
	;(window as any).__vmdFrontMatter?.rebind?.()
	;(window as any).__vmdSearch?.rebind?.()
	;(window as any).__vmdLineNumbers?.rebind?.()
	;(window as any).__vmdSplitScrollSync?.rebind?.(window.vditor)
}

let forwardingModeShortcut = false

function selectEditorMode(mode: VditorMode): void {
	const editor = window.vditor
	if (!editor) return
	if (getVditorMode(editor) !== mode) {
		const editorElement = getVditorEditorElement(editor)
		if (!editorElement) return
		const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
		forwardingModeShortcut = true
		try {
			// Vditor has no public mode setter. Forward only its two supported
			// built-in mode shortcuts through the active editor element instead of
			// importing the private three-mode toolbar implementation.
			editorElement.dispatchEvent(new KeyboardEvent('keydown', {
				key: mode === 'wysiwyg' ? '7' : '9',
				code: mode === 'wysiwyg' ? 'Digit7' : 'Digit9',
				ctrlKey: !isMac,
				metaKey: isMac,
				altKey: true,
				bubbles: true,
				cancelable: true,
			}))
		} finally {
			forwardingModeShortcut = false
		}
	}
	syncEditorModeToolbar(editor)
	queueMicrotask(() => {
		refreshModeDependentFeatures()
		saveVditorOptions()
	})
}

/** Owns the only supported mode shortcuts and consumes the removed middle one. */
export function installEditorModeShortcuts(): void {
	if ((window as any).__vmdEditorModeShortcuts) return

	const onKeydown = (event: KeyboardEvent) => {
		if (forwardingModeShortcut) return
		const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
		const primary = isMac
			? event.metaKey && !event.ctrlKey
			: event.ctrlKey && !event.metaKey
		if (
			!primary ||
			!event.altKey ||
			event.shiftKey ||
			!/^Digit[7-9]$/.test(event.code)
		) {
			return
		}

		const editorElement = getVditorEditorElement()
		if (
			!editorElement ||
			!(event.target instanceof Node) ||
			!editorElement.contains(event.target)
		) {
			return
		}

		event.preventDefault()
		event.stopImmediatePropagation()
		if (event.code === 'Digit7') {
			selectEditorMode('wysiwyg')
		} else if (event.code === 'Digit9') {
			selectEditorMode('sv')
		}
	}

	document.addEventListener('keydown', onKeydown, true)
	;(window as any).__vmdEditorModeShortcuts = {
		dispose() {
			document.removeEventListener('keydown', onKeydown, true)
			delete (window as any).__vmdEditorModeShortcuts
		},
	}
}

export const toolbar = [
	{
		name: 'outline',
		tipPosition: 's',
		tip: t('toggleOutline'),
		className: 'vmd-outline-toggle',
		icon: outlineIcon,
	},
	{
		name: 'line-numbers',
		tipPosition: 's',
		tip: t('toggleLineNumbers'),
		className: 'vmd-line-numbers-toggle',
		icon: lineNumbersIcon,
		click() {
			;(window as any).__vmdLineNumbers?.toggle()
		},
	},
	'|',
	{
		hotkey: '⌘s',
		name: 'save',
		tipPosition: 's',
		tip: t('save'),
		className: 'save',
		icon:
			'<svg viewBox="85 85 854 854" xmlns="http://www.w3.org/2000/svg"><path d="M810.667 938.667H213.333a128 128 0 01-128-128V213.333a128 128 0 01128-128h469.334a42.667 42.667 0 0130.293 12.374L926.293 311.04a42.667 42.667 0 0112.374 30.293v469.334a128 128 0 01-128 128zm-597.334-768a42.667 42.667 0 00-42.666 42.666v597.334a42.667 42.667 0 0042.666 42.666h597.334a42.667 42.667 0 0042.666-42.666v-451.84l-188.16-188.16z"/><path d="M725.333 938.667A42.667 42.667 0 01682.667 896V597.333H341.333V896A42.667 42.667 0 01256 896V554.667A42.667 42.667 0 01298.667 512h426.666A42.667 42.667 0 01768 554.667V896a42.667 42.667 0 01-42.667 42.667zM640 384H298.667A42.667 42.667 0 01256 341.333V128a42.667 42.667 0 0185.333 0v170.667H640A42.667 42.667 0 01640 384z"/></svg>',
		click() {
			;(window as any).__vmdPostDocumentCommand('save')
		},
	},

	'headings',
	'bold',
	'italic',
	'strike',
	'link',
	'|',
	'list',
	'ordered-list',
	'check',
	{
		name: 'outdent',
		hotkey: '',
		tip: t('outdentList'),
	},
	{
		name: 'indent',
		hotkey: '',
		tip: t('indentList'),
	},
	'|',
	'quote',
	'line',
	'code',
	'inline-code',
	{
		name: 'math-block',
		tip: t('mathBlock'),
		icon: mathBlockIcon,
		click() {
			const editor = window.vditor
			editor.insertMD(toMathBlock(editor.getSelection()))
			;(window as any).__vmdCommitProgrammaticEdit?.()
		},
	},
	{
		name: 'math-inline',
		tip: t('mathInline'),
		icon: mathInlineIcon,
		click() {
			const editor = window.vditor
			editor.insertMD(toInlineMath(editor.getSelection()))
			;(window as any).__vmdCommitProgrammaticEdit?.()
		},
	},
	{
		name: 'details',
		tip: t('detailsBlock'),
		icon: detailsIcon,
		click() {
			insertDetails(window.vditor)
			;(window as any).__vmdCommitProgrammaticEdit?.()
		},
	},
	'insert-before',
	'insert-after',
	'|',
	'upload',
	'table',
	'|',
	{
		name: 'vmd-edit-mode',
		tipPosition: 'e',
		tip: t('editingMode'),
		icon: editingModeIcon,
		toolbar: [
			{
				name: 'vmd-mode-wysiwyg',
				icon: t('wysiwygMode'),
				click() {
					selectEditorMode('wysiwyg')
				},
			},
			{
				name: 'vmd-mode-sv',
				icon: t('splitViewMode'),
				click() {
					selectEditorMode('sv')
				},
			},
		],
	},
	{
		name: 'more',
		tipPosition: 'e',
		toolbar: [
			{
				name: 'copy-markdown',
				icon: t('copyMarkdown'),
				async click() {
					await copyToClipboard(vditor.getValue(), 'Markdown')
				},
			},
			{
				name: 'copy-html',
				icon: t('copyHtml'),
				async click() {
					await copyToClipboard(vditor.getHTML(), 'HTML')
				},
			},
			{
				name: 'reload-workspace-style',
				icon: t('reloadWorkspaceStyle'),
				click() {
					vscode.postMessage({
						command: 'reload-workspace-style',
					})
				},
			},
			{
				name: 'normalize-formatting',
				icon: t('normalizeFormatting'),
				click() {
					confirm(t('normalizeFormattingConfirm'), () => {
						;(window as any).__vmdPostDocumentCommand('normalize-formatting')
					})
				},
			},
			{
				name: 'reset-config',
				icon: t('resetConfig'),
				click() {
					confirm(t('resetConfirm'), () => {
						;(window as any).__vmdPostDocumentCommand('reset-config')
					})
				},
			},
			'devtools',
			'info',
			'help',
		],
	},
].map((it: any) => {
	if (typeof it === 'string') {
		it = { name: it }
	}
	it.tipPosition = it.tipPosition || 's'
	return it
})
