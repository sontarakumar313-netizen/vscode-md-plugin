# Changelog

All notable changes to Markdown Interactor will be documented in this file.

## Unreleased

- Added two bundled light/dark themes that use the active VS Code palette and
  switch automatically when the VS Code color theme changes.
- Made inline code, fenced code blocks, and syntax highlighting consistently
  dark in the built-in dark theme.
- Prevented delayed document/auto-save updates from resetting the editor caret,
  including while editing table cells.
- Deferred synchronization during IME composition so auto save and external
  document updates cannot interrupt unfinished composed text.
- Added versioned edit acknowledgements and minimal-range `WorkspaceEdit`
  updates instead of replacing the entire Markdown document on every input.
- Added three-way merging for concurrent external changes. Independent edits
  merge automatically, while overlapping edits pause and require an explicit
  choice before either side is replaced.
- Added rendering support for LaTeX inline math delimiters (`\(...\)`) while
  preserving them when editor content is synchronized back to Markdown.

## 0.1.7

- Added an expandable find/replace workflow with selection prefill, match
  navigation, and canonical-Markdown replacement from the Split View source
  pane.
- Added formula block and inline formula toolbar controls immediately after the
  code block and inline code controls.
- Replaced Split View's one-way, height-drifting scroll behavior with
  bidirectional normalized pane synchronization and resize reconciliation.
- Added semantic boundaries for separate list regions and constrained Tab and
  Shift+Tab to supported list and table editing contexts.

## 0.1.6

- Coalesced rapid full-document Webview edits while preserving immediate flushes
  for save, focus loss, page hiding, and IME completion.
- Bounded synchronization snapshot history and collapsed queued edits to reduce
  memory and write pressure for large Markdown documents.
- Hardened uploads with decoded-size, Base64, MIME, signature, extension, and
  path validation; added configurable upload limits and remote-media control.
- Restricted document links to approved external URI schemes and centralized
  Vditor private API usage behind a compatibility adapter.

## 0.1.5

- Fixed a custom-editor startup race that could lose the Webview `ready` message
  and leave Markdown files blank when opened through the default editor.
- Made development startup build Webview assets before the extension host starts,
  and retained the last completed asset bundle while watch mode initializes.

## 0.1.2

- Bundled the Vditor SVG icon sprite so toolbar and table context-menu icons
  remain visible when remote scripts are blocked or the user is offline.

## 0.1.0

- Initial release under the Markdown Interactor name.
- Added instant-rendering, WYSIWYG, and split-screen editing modes.
- Added VS Code custom editor, context-menu, command, and keyboard integrations.
- Added math, diagram, image upload, search, outline, line-number, and table editing support.
- Added automatic VS Code theme adaptation and workspace-level custom CSS.
- Fixed duplicate link opening, edit synchronization races, local links with
  fragments, multi-mode search and scroll tracking, upload validation, and
  configuration reset ordering.
- Added a restrictive Webview content security policy and Webview type checking.
