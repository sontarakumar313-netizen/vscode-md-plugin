import * as NodePath from 'path'
import * as vscode from 'vscode'

const ALLOWED_EXTERNAL_URI_SCHEMES = new Set(['http', 'https', 'mailto'])

export function isAllowedExternalUriScheme(scheme: string): boolean {
  return ALLOWED_EXTERNAL_URI_SCHEMES.has(scheme.toLowerCase())
}

/**
 * Opens approved external URIs and resolves local links from the Markdown file.
 */
export async function openMarkdownLink(
  markdownFileUri: vscode.Uri,
  href: string
): Promise<void> {
  const target = href.trim()
  if (!target) return

  if (/^https?:\/\//i.test(target)) {
    await vscode.env.openExternal(vscode.Uri.parse(target))
    return
  }

  let localUri: vscode.Uri
  let openUri: vscode.Uri

  if (/^[a-zA-Z]:[\\/]/.test(target)) {
    const parts = splitLocalTarget(target)
    localUri = vscode.Uri.file(decodeLocalPath(parts.path))
    openUri = localUri.with({ query: parts.query, fragment: parts.fragment })
  } else if (/^file:/i.test(target)) {
    openUri = vscode.Uri.parse(target)
    localUri = openUri.with({ query: '', fragment: '' })
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) {
    const uri = vscode.Uri.parse(target)
    // Markdown is document content, so only browser-safe external schemes are
    // delegated to the operating system. In particular, never allow vscode:,
    // command:, data:, or arbitrary custom URI schemes to escape the webview.
    if (!isAllowedExternalUriScheme(uri.scheme)) return
    await vscode.env.openExternal(uri)
    return
  } else {
    const parts = splitLocalTarget(target)
    localUri = vscode.Uri.file(
      NodePath.resolve(
        NodePath.dirname(markdownFileUri.fsPath),
        decodeLocalPath(parts.path)
      )
    )
    openUri = localUri.with({ query: parts.query, fragment: parts.fragment })
  }

  let fileStat: vscode.FileStat
  try {
    fileStat = await vscode.workspace.fs.stat(localUri)
  } catch (error) {
    return
  }

  if ((fileStat.type & vscode.FileType.Directory) !== 0) {
    await vscode.commands.executeCommand('revealInExplorer', localUri)
    return
  }

  await vscode.commands.executeCommand('vscode.open', openUri)
}

interface LocalLinkParts {
  path: string
  query: string
  fragment: string
}

function splitLocalTarget(target: string): LocalLinkParts {
  const hashIndex = target.indexOf('#')
  const queryIndex = target.indexOf('?')
  const pathEnd = [hashIndex, queryIndex]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), target.length)

  const queryEnd = hashIndex >= 0 ? hashIndex : target.length
  return {
    path: target.slice(0, pathEnd),
    query:
      queryIndex >= 0 && queryIndex < queryEnd
        ? target.slice(queryIndex + 1, queryEnd)
        : '',
    fragment: hashIndex >= 0 ? decodeLocalPath(target.slice(hashIndex + 1)) : '',
  }
}

function decodeLocalPath(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch (_) {
    return value
  }
}
