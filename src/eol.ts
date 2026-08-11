import type * as vscode from 'vscode'

export type TextEol = '\n' | '\r\n'

/** Normalizes document text into the LF-only space used by Vditor. */
export function toLf(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** Converts LF-oriented text back to a document's preferred line ending. */
export function applyEol(text: string, eol: TextEol): string {
  const normalized = toLf(text)
  return eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized
}

/** Returns the textual delimiter represented by VS Code's EndOfLine enum. */
export function documentEol(
  document: Pick<vscode.TextDocument, 'eol'>
): TextEol {
  // vscode.EndOfLine.CRLF is 2. Keep the dependency type-only so the helpers
  // remain directly testable in Node without loading the VS Code runtime.
  return document.eol === 2 ? '\r\n' : '\n'
}
