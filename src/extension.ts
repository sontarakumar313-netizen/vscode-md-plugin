import * as vscode from 'vscode'
import { MarkdownEditorProvider } from './custom-editor-provider'
import { showError } from './notifications'
import { KeyVditorOptions } from './webview'
import { generateWorkspaceStyle } from './workspace-style'

async function openMarkdownEditor(uri?: vscode.Uri): Promise<void> {
  const activeDocument = vscode.window.activeTextEditor?.document
  const resource = uri || activeDocument?.uri
  if (!resource) {
    showError(`Did not open markdown file!`)
    return
  }

  let document: vscode.TextDocument
  try {
    document = await vscode.workspace.openTextDocument(resource)
  } catch (error) {
    console.error(error)
    showError(`Cannot open markdown file!`)
    return
  }

  if (!uri && document.languageId !== 'markdown') {
    showError(`Current file language is not markdown, got ${document.languageId}`)
    return
  }

  await vscode.commands.executeCommand(
    'vscode.openWith',
    document.uri,
    MarkdownEditorProvider.viewType
  )
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-interactor.openEditor',
      async (uri?: vscode.Uri) => {
        try {
          await openMarkdownEditor(uri)
        } catch (error) {
          console.error(error)
          showError(`Failed to open Markdown Interactor`)
        }
      }
    ),
    vscode.commands.registerCommand(
      'markdown-interactor.generateWorkspaceStyle',
      (uri?: vscode.Uri) => {
        const resource = uri || vscode.window.activeTextEditor?.document.uri
        void generateWorkspaceStyle(context, resource).catch((error) => {
          console.error(error)
          showError(`Failed to generate workspace CSS`)
        })
      }
    ),
    vscode.window.registerCustomEditorProvider(
      MarkdownEditorProvider.viewType,
      new MarkdownEditorProvider(context),
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  )

  context.globalState.setKeysForSync([KeyVditorOptions])
}
