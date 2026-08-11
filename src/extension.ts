import * as vscode from 'vscode'
import { MarkdownEditorProvider } from './custom-editor-provider'
import { EditorPanel } from './editor-panel'
import { showError } from './notifications'
import { KeyVditorOptions } from './webview'
import { generateWorkspaceStyle } from './workspace-style'

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-interactor.openEditor',
      (uri?: vscode.Uri, ...args: unknown[]) => {
        console.log('command', uri, args)
        void EditorPanel.createOrShow(context, uri).catch((error) => {
          console.error(error)
          showError(`Failed to open Markdown Interactor`)
        })
      }
    ),
    vscode.commands.registerCommand(
      'markdown-interactor.generateWorkspaceStyle',
      (uri?: vscode.Uri) => {
        const resource =
          uri ||
          vscode.window.activeTextEditor?.document.uri ||
          EditorPanel.currentUri
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
