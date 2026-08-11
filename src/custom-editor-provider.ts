import * as NodePath from 'path'
import * as vscode from 'vscode'
import { EditorPanel } from './editor-panel'
import { toLf } from './eol'
import { openMarkdownLink } from './link-handler'
import {
  getAssetsFolder,
  getWebviewHtml,
  getWebviewOptions,
  applyMinimalDocumentEdit,
  MarkdownWebviewController,
} from './webview'

/** Provides the `Open With...` and default custom editor integration. */
export class MarkdownEditorProvider
  implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'markdown-interactor.customEditor'

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const uri = document.uri
    const disposables: vscode.Disposable[] = []
    let panelDisposed = false

    webviewPanel.webview.options = getWebviewOptions(this.context, uri)
    webviewPanel.title = NodePath.basename(uri.fsPath)

    const syncToEditor = async (
      content: string
    ): Promise<vscode.TextDocument> => {
      return applyMinimalDocumentEdit(document, content)
    }

    const controller = new MarkdownWebviewController({
      context: this.context,
      panel: webviewPanel,
      uri,
      isDisposed: () => panelDisposed,
      getSnapshot: async () => ({
        content: toLf(document.getText()),
        version: document.version,
      }),
      syncToDocument: syncToEditor,
      getAssetsFolder: () => getAssetsFolder(uri),
      openLink: (href) => openMarkdownLink(uri, href),
      getScrollTop: () => EditorPanel.getScrollTop(uri),
      saveScrollPosition: (top) => {
        EditorPanel.saveScrollPosition(uri, top)
      },
    })
    disposables.push(controller)

    // The webview can post `ready` from a cached script immediately. Register
    // its message listener before assigning HTML so the initial document update
    // cannot be lost.
    webviewPanel.webview.html = getWebviewHtml(
      this.context,
      webviewPanel.webview,
      uri
    )

    vscode.workspace.onDidChangeTextDocument(
      (event) => {
        if (
          panelDisposed ||
          event.document.uri.toString() !== uri.toString()
        ) {
          return
        }
        if (controller.observeDocumentChange(event.document)) {
          return
        }

        void controller
          .update()
          .catch((error) => {
            if (!panelDisposed) console.error(error)
          })
      },
      null,
      disposables
    )

    vscode.window.onDidChangeActiveColorTheme(
      () => {
        if (panelDisposed) return
        void controller.updateTheme().catch((error) => {
          if (!panelDisposed) console.error(error)
        })
      },
      null,
      disposables
    )

    webviewPanel.onDidDispose(() => {
      panelDisposed = true
      disposables.forEach((disposable) => disposable.dispose())
    })
  }
}
