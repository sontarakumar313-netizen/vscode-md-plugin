<p align="center">
  <img src="media/logo.png" width="128" height="128" alt="Markdown Interactor logo">
</p>

<h1 align="center">Markdown Interactor</h1>

<p align="center">
  在 VS Code 中直接编辑、渲染和管理 Markdown，兼顾可视化编辑与源码分屏体验。
</p>

<p align="center">
  <a href="https://github.com/sontarakumar313-netizen/vscode-md-plugin/actions/workflows/release.yml"><img src="https://github.com/sontarakumar313-netizen/vscode-md-plugin/actions/workflows/release.yml/badge.svg?branch=main" alt="Build status"></a>
  <a href="https://github.com/sontarakumar313-netizen/vscode-md-plugin/blob/main/LICENSE"><img src="https://img.shields.io/github/license/sontarakumar313-netizen/vscode-md-plugin" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/VS%20Code-%5E1.51.0-007ACC?logo=visualstudiocode&logoColor=white" alt="VS Code 1.51 or later">
</p>

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#使用">使用</a> ·
  <a href="#配置">配置</a> ·
  <a href="#自定义样式">自定义样式</a> ·
  <a href="#开发">开发</a>
</p>

## 简介

Markdown Interactor 是一个基于 [Vditor](https://github.com/Vanessa219/vditor) 的 VS Code Markdown 编辑器。它在 Webview 中提供丰富的可视化编辑能力，同时始终以 VS Code `TextDocument` 作为文档数据源，因此文件保存、撤销、自动保存和外部修改仍由 VS Code 管理。

适合以下场景：

- 编写包含表格、任务列表、公式和图表的技术文档；
- 希望边写边看效果，但仍保留随时编辑原始 Markdown 的能力；
- 需要项目级主题、资源上传和本地链接支持；
- 在中文输入法、自动保存或外部工具同时修改文件时保持稳定编辑。

## 核心功能

### 两种编辑模式


| 模式                        | 说明                                                       |
| --------------------------- | ---------------------------------------------------------- |
| **可视化编辑（WYSIWYG）**   | 默认模式，以接近最终排版的方式直接编辑文档。               |
| **源码分屏（Split View）**  | 左侧编辑 Markdown 源码，右侧同步预览，并支持双向滚动联动。 |

编辑模式会自动记忆，并可通过顶部工具栏随时切换。模式快捷键为 `Ctrl/Cmd+Alt+7`（可视化编辑）和 `Ctrl/Cmd+Alt+9`（源码分屏）。

### Markdown 与写作能力

- 标题、粗体、斜体、删除线、引用、分隔线和代码；
- 无序列表、有序列表、任务列表及列表缩进；
- 表格插入，以及行、列、对齐和删除等右键操作；
- 图片、音频、本地文件链接和可折叠 `<details>` 内容；
- KaTeX 数学公式，仅支持 `$...$` 和 `$$...$$`；
- GitHub Alerts，支持 Note、Tip、Important、Warning 和 Caution；
- Mermaid、Graphviz、ECharts 和 abc.js 等 Vditor 扩展语法；
- 一键复制原始 Markdown 或渲染后的 HTML。

### 编辑辅助

- 文档目录和源码行号开关；
- 查找、区分大小写、上一项和下一项导航；
- 在分屏源码模式中执行单项替换或全部替换；
- 公式块和行内公式快捷插入；
- 长文档滚动位置恢复；
- 中、英、日、韩界面文本适配，缺失文本自动回退到英文。

> 为避免可视文本与 Markdown 语法偏移不一致，可视化编辑模式只提供查找与定位；替换操作仅在源码分屏模式的编辑区启用。

### 稳定的文档同步

- 连续输入会合并后同步，减少大型文档的写入压力；
- 只向 VS Code 文档应用最小文本变更，不在每次输入时替换整篇文件；
- 保存、失焦、页面隐藏和输入法提交时会立即同步；
- 输入法组合期间不会用未完成的候选文本覆盖文档；
- 外部修改与当前编辑互不冲突时会自动三方合并；
- 修改范围重叠时会暂停同步，并让用户选择保留编辑器内容或外部内容。

### 媒体与链接安全

粘贴、拖放或选择媒体后，文件会保存到配置的资源目录并自动插入 Markdown。当前支持：

- 图片：PNG、JPEG、GIF、WebP；
- 音频：WAV、MP3、Ogg；
- 单次最多 20 个文件；
- 默认单文件上限为 10 MB，可配置为 1 至 100 MB。

扩展宿主会校验 Base64 数据、实际文件签名、MIME、扩展名、大小和目标路径。文档链接只允许安全的外部协议以及本地文件路径；远程 HTTPS 媒体也可以通过设置完全关闭。

## 安装

### 从 GitHub Releases 安装

1. 打开项目的 [Releases](https://github.com/sontarakumar313-netizen/vscode-md-plugin/releases) 页面并下载最新的 `.vsix` 文件。
2. 在 VS Code 中打开命令面板。
3. 运行 **Extensions: Install from VSIX...**。
4. 选择下载的文件并按提示完成安装。

仓库每次推送到 `main` 后都会自动构建 continuous 版本，可用于获取最新改动。

### 从源码运行

需要 [Node.js](https://nodejs.org/) 20 或更高版本，以及 [pnpm](https://pnpm.io/)。

```bash
pnpm install
pnpm build
```

构建完成后，在 VS Code 中按 `F5` 启动 Extension Development Host。

## 使用

打开 `.md` 或 `.markdown` 文件后，可通过以下任一方式进入 Markdown Interactor：

- 在命令面板运行 **Markdown Interactor: Open with Markdown Interactor**；
- 在资源管理器中右键 Markdown 文件并选择 **Open with Markdown Interactor**；
- 在 Markdown 编辑器标签页的右键菜单中选择同名命令；
- 选择 **Open With... → Markdown Interactor**；
- 在 **Configure Default Editor...** 中将其设为 Markdown 默认编辑器；
- Windows / Linux 按 `Ctrl+Shift+Alt+M`，macOS 按 `Cmd+Shift+Alt+M`。

### 常用快捷键


| 操作                     | Windows / Linux         | macOS                   |
| ------------------------ | ----------------------- | ----------------------- |
| 打开 Markdown Interactor | `Ctrl+Shift+Alt+M`      | `Cmd+Shift+Alt+M`       |
| 保存                     | `Ctrl+S`                | `Cmd+S`                 |
| 查找                     | `Ctrl+F`                | `Cmd+F`                 |
| 下一个 / 上一个结果      | `Enter` / `Shift+Enter` | `Enter` / `Shift+Enter` |
| 列表缩进 / 减少缩进      | `Tab` / `Shift+Tab`     | `Tab` / `Shift+Tab`     |
| 切换 Tab 是否移动焦点    | `Ctrl+M`                | `Cmd+M`                 |

在列表和表格之外，`Tab` 默认不会移出编辑器。按 `Ctrl+M`（macOS 为 `Cmd+M`）可让 `Tab`
恢复为普通的焦点切换键，再按一次即可恢复结构化缩进行为。这与 VS Code 自身的
"Toggle Tab Key Moves Focus" 使用同一快捷键。

## 配置

在 VS Code 设置中搜索 `Markdown Interactor`，或直接配置以下项目：


| 设置                                      | 默认值   | 说明                                                           |
| ----------------------------------------- | -------- | -------------------------------------------------------------- |
| `markdown-interactor.imageSaveFolder`     | `assets` | 上传文件保存目录。相对路径以当前 Markdown 文件所在目录为基准。 |
| `markdown-interactor.maxUploadSizeMB`     | `10`     | 每个上传文件的大小上限，允许范围为 1 至 100 MB。               |
| `markdown-interactor.allowRemoteMedia`    | `true`   | 是否允许加载 Markdown 中的 HTTPS 图片和媒体。                  |
| `markdown-interactor.useVscodeThemeColor` | `true`   | 是否在编辑器中使用当前 VS Code 主题色。                        |

关闭 `allowRemoteMedia` 只会阻止文档里引用的远程图片、视频和音频，不会阻止远程字体、
样式表和脚本，编辑器自身需要加载后者。

`imageSaveFolder` 支持以下变量：


| 变量                         | 含义                         |
| ---------------------------- | ---------------------------- |
| `${projectRoot}`             | 当前文件所属工作区的根目录   |
| `${file}`                    | 当前 Markdown 文件的完整路径 |
| `${fileBasenameNoExtension}` | 不含扩展名的当前文件名       |
| `${dir}`                     | 当前 Markdown 文件所在目录   |

例如，将资源统一保存到工作区根目录的 `assets` 文件夹：

```json
{
  "markdown-interactor.imageSaveFolder": "${projectRoot}/assets"
}
```

## 自定义样式

扩展内置浅色和深色两套主题，并随 VS Code 当前主题自动切换。还可以为每个工作区提供完整的自定义 CSS：

1. 在命令面板运行 **Markdown Interactor: Generate Default Workspace CSS**。
2. 编辑生成的 `.vscode/markdown-interactor.css`。
3. 在编辑器顶部的 **More** 菜单中选择 **Reload workspace CSS**。

扩展只读取当前 Markdown 文件所属工作区中的 `.vscode/markdown-interactor.css`，不会向父目录继续查找。样式文件不会自动监听，修改后需要手动重新加载。

[`00-styles/`](00-styles/) 中还提供三套可直接使用的工作区主题和一个自定义模板，具体说明见 [`00-styles/README.md`](00-styles/README.md)。

## 开发

安装依赖、构建并运行测试：

```bash
pnpm install
pnpm build
pnpm test
```

开发时监听源码变化：

```bash
pnpm watch
```

GitHub Actions 会在代码推送到 `main` 后自动构建并打包 VSIX，无需在本地维护额外的发布命令。

主要源码目录：


| 路径             | 作用                                             |
| ---------------- | ------------------------------------------------ |
| `src/`           | VS Code Extension Host、文档同步、上传和链接处理 |
| `media-src/src/` | Webview、Vditor、工具栏、查找、行号和交互逻辑    |
| `scripts/`       | 构建脚本与自动化测试                             |
| `00-styles/`     | 工作区自定义 CSS 示例                            |

更多版本变化见 [CHANGELOG.md](CHANGELOG.md)。问题与建议请提交到 [GitHub Issues](https://github.com/sontarakumar313-netizen/vscode-md-plugin/issues)。

## 致谢

Markdown Interactor 基于 [zaaack/vscode-markdown-editor](https://github.com/zaaack/vscode-markdown-editor) 演进，并由 [Vditor](https://github.com/Vanessa219/vditor) 提供 Markdown 编辑与渲染能力。

## 许可证

本项目基于 [MIT License](https://github.com/sontarakumar313-netizen/vscode-md-plugin/blob/main/LICENSE) 开源。

<details>
<summary>这是一个标题</summary>
这是被折叠的内容
</details>
