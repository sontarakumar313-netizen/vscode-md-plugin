import * as NodePath from 'path'
import * as vscode from 'vscode'
import { toLf } from './eol'
import { openMarkdownLink } from './link-handler'
import { showError } from './notifications'
import {
  getAssetsFolder,
  getWebviewHtml,
  getWebviewOptions,
  applyMinimalDocumentEdit,
  MarkdownWebviewController,
  MarkdownWebviewHost,
} from './webview'

/** Manages the singleton Webview panel opened through commands and menus. */
export class EditorPanel implements vscode.Disposable {
  public static currentPanel: EditorPanel | undefined
  public static readonly viewType = 'markdown-interactor'

  private static readonly scrollPositions = new Map<string, number>()

  private static isSameUri(left: vscode.Uri, right: vscode.Uri): boolean {
    return left.toString() === right.toString()
  }

  public static get currentUri(): vscode.Uri | undefined {
    return EditorPanel.currentPanel?._uri
  }

  public static getScrollTop(uri: vscode.Uri): number {
    return EditorPanel.scrollPositions.get(uri.fsPath) || 0
  }

  public static saveScrollPosition(uri: vscode.Uri, top: number): void {
    EditorPanel.scrollPositions.set(uri.fsPath, top)
  }

  public static async createOrShow(
    context: vscode.ExtensionContext,
    uri?: vscode.Uri
  ): Promise<void> {
    const activeDocument = vscode.window.activeTextEditor?.document
    const column = vscode.window.activeTextEditor?.viewColumn

    // Resolve the target before disposing an existing panel. A command-palette
    // invocation may not include a URI or have an active text editor.
    if (!uri && !activeDocument && EditorPanel.currentPanel) {
      EditorPanel.currentPanel._panel.reveal(column)
      void EditorPanel.currentPanel._panel.webview.postMessage({
        command: 'focus',
      })
      return
    }
    if (!activeDocument && !uri) {
      showError(`Did not open markdown file!`)
      return
    }

    let document: vscode.TextDocument | undefined
    try {
      document = uri
        ? await vscode.workspace.openTextDocument(uri)
        : activeDocument
    } catch (error) {
      console.error(error)
      showError(`Cannot open markdown file!`)
      return
    }

    if (!document) {
      showError(`Cannot find markdown file!`)
      return
    }
    if (!uri && document.languageId !== 'markdown') {
      showError(`Current file language is not markdown, got ${document.languageId}`)
      return
    }

    const currentPanel = EditorPanel.currentPanel
    if (currentPanel && EditorPanel.isSameUri(document.uri, currentPanel._uri)) {
      currentPanel._panel.reveal(column)
      void currentPanel._panel.webview.postMessage({ command: 'focus' })
      return
    }

    currentPanel?.dispose()

    const panel = vscode.window.createWebviewPanel(
      EditorPanel.viewType,
      'Markdown Interactor',
      column || vscode.ViewColumn.One,
      getWebviewOptions(context, document.uri)
    )

    EditorPanel.currentPanel = new EditorPanel(context, panel, document)
  }

  private readonly _disposables: vscode.Disposable[] = []
  private readonly _webviewController: MarkdownWebviewController
  private _disposed = false
  private _textEditTimer: NodeJS.Timeout | undefined

  private constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _panel: vscode.WebviewPanel,
    private _document: vscode.TextDocument,
    private readonly _uri = _document.uri
  ) {
    this._webviewController = new MarkdownWebviewController(
      this._createWebviewHost()
    )
    this._disposables.push(this._webviewController)

    this._init()

    this._panel.onDidDispose(() => this._dispose(true), null, this._disposables)

    vscode.window.onDidChangeActiveColorTheme(
      () => {
        if (this._disposed) return
        void this._webviewController
          .updateTheme()
          .catch((error) => {
            if (!this._disposed) console.error(error)
          })
      },
      null,
      this._disposables
    )

    vscode.workspace.onDidChangeTextDocument(
      (event) => {
        if (
          this._disposed ||
          !EditorPanel.isSameUri(event.document.uri, this._uri)
        ) {
          return
        }
        this._document = event.document

        if (
          this._webviewController.observeDocumentChange(event.document)
        ) {
          return
        }
        if (this._textEditTimer) clearTimeout(this._textEditTimer)
        this._textEditTimer = setTimeout(() => {
          this._textEditTimer = undefined
          if (this._disposed) return
          void this._webviewController
            .update()
            .catch((error) => {
              if (!this._disposed) console.error(error)
            })
        }, 300)
      },
      null,
      this._disposables
    )
  }

  private _createWebviewHost(): MarkdownWebviewHost {
    return {
      context: this._context,
      panel: this._panel,
      uri: this._uri,
      isDisposed: () => this._disposed,
      getSnapshot: () => this._getSnapshot(),
      syncToDocument: (content) => this._syncToEditor(content),
      getAssetsFolder: () => getAssetsFolder(this._uri),
      openLink: (href) => openMarkdownLink(this._uri, href),
      getScrollTop: () => EditorPanel.getScrollTop(this._uri),
      saveScrollPosition: (top) => {
        EditorPanel.saveScrollPosition(this._uri, top)
      },
    }
  }

  private _init(): void {
    this._panel.webview.html = getWebviewHtml(
      this._context,
      this._panel.webview,
      this._uri
    )
    this._panel.title = NodePath.basename(this._uri.fsPath)
  }

  private async _getSnapshot(): Promise<{ content: string; version: number }> {
    let document = this._getOpenDocument()
    if (!document) {
      document = await vscode.workspace.openTextDocument(this._uri)
      this._document = document
    }
    return {
      content: toLf(document.getText()),
      version: document.version,
    }
  }

  private _getOpenDocument(): vscode.TextDocument | undefined {
    const document = vscode.workspace.textDocuments.find((candidate) =>
      EditorPanel.isSameUri(candidate.uri, this._uri)
    )
    if (document) this._document = document
    return document
  }

  private async _syncToEditor(
    content: string
  ): Promise<vscode.TextDocument | undefined> {
    if (this._disposed) return

    let document = this._getOpenDocument()
    if (!document) {
      try {
        document = await vscode.workspace.openTextDocument(this._uri)
      } catch (error) {
        if (this._disposed) return
        console.error(error)
        throw error
      }
      if (this._disposed) return
      this._document = document
    }

    return applyMinimalDocumentEdit(document, content)
  }

  private _dispose(panelAlreadyDisposed: boolean): void {
    if (this._disposed) return
    this._disposed = true

    if (this._textEditTimer) {
      clearTimeout(this._textEditTimer)
      this._textEditTimer = undefined
    }
    if (EditorPanel.currentPanel === this) {
      EditorPanel.currentPanel = undefined
    }

    while (this._disposables.length) {
      this._disposables.pop()?.dispose()
    }

    if (!panelAlreadyDisposed) this._panel.dispose()
  }

  public dispose(): void {
    this._dispose(false)
  }
}
