import * as vscode from 'vscode'
import { showError } from './notifications'

export interface WorkspaceStyle {
  css: string | null
  path: string | null
}

export function getWorkspaceStyleFileUri(
  resource?: vscode.Uri
): vscode.Uri | undefined {
  const workspaceFolder =
    (resource && vscode.workspace.getWorkspaceFolder(resource)) ||
    vscode.workspace.workspaceFolders?.[0]
  if (!workspaceFolder) return

  return vscode.Uri.joinPath(
    workspaceFolder.uri,
    '.vscode',
    'markdown-interactor.css'
  )
}

export async function getWorkspaceStyle(
  resource: vscode.Uri
): Promise<WorkspaceStyle> {
  // Only the active document's workspace (or the window's first workspace for
  // an external file) may provide custom CSS. Never search parent directories.
  const styleFile = getWorkspaceStyleFileUri(resource)
  if (!styleFile) return { css: null, path: null }

  try {
    const content = await vscode.workspace.fs.readFile(styleFile)
    return {
      css: Buffer.from(content).toString('utf8'),
      path: styleFile.fsPath,
    }
  } catch (error) {
    if (
      error instanceof vscode.FileSystemError &&
      (error.code === 'FileNotFound' || error.code === 'EntryNotFound')
    ) {
      return { css: null, path: null }
    }
    throw error
  }
}

export async function generateWorkspaceStyle(
  context: vscode.ExtensionContext,
  resource?: vscode.Uri
): Promise<void> {
  const target = getWorkspaceStyleFileUri(resource)
  if (!target) {
    showError(`Open a workspace before generating the custom CSS file.`)
    return
  }

  try {
    await vscode.workspace.fs.stat(target)
    const overwrite = await vscode.window.showWarningMessage(
      `${target.fsPath} already exists. Overwrite it with the default CSS?`,
      { modal: true },
      'Overwrite'
    )
    if (overwrite !== 'Overwrite') return
  } catch (error) {
    if (
      !(error instanceof vscode.FileSystemError) ||
      (error.code !== 'FileNotFound' && error.code !== 'EntryNotFound')
    ) {
      throw error
    }
  }

  const template = vscode.Uri.joinPath(
    context.extensionUri,
    'media',
    'markdown-interactor.default.css'
  )
  const content = await vscode.workspace.fs.readFile(template)
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'))
  await vscode.workspace.fs.writeFile(target, content)

  const document = await vscode.workspace.openTextDocument(target)
  await vscode.window.showTextDocument(document)
  vscode.window.showInformationMessage(
    `Generated ${target.fsPath}. Use “Reload workspace CSS” in the editor's More menu to apply it.`
  )
}
