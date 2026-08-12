# Markdown Interactor 样式文件

本目录保存可以用于 Markdown Interactor 的自定义 CSS 文件。

## 使用方式

插件只读取当前 Markdown 文件所属工作区下的 `.vscode/markdown-interactor.css`；外部文件使用窗口中的第一个工作区。插件不会向父目录查找，当前工作区没有该文件时直接使用内置默认样式：

1. 在命令面板运行 `Markdown Interactor: Generate Default Workspace CSS`（也可以点击插件设置中的生成链接），或手动将 CSS 文件复制为项目根目录下的 `.vscode/markdown-interactor.css`。
2. 修改文件后，在编辑器顶部工具栏的“更多”菜单中点击“刷新加载工作区 CSS”。

每个编辑器面板只在初始化时自动加载一次，不监听文件变化；手动刷新只替换样式，不会重建编辑器。如果文件不存在，插件会使用内置的浅色、深色两套默认主题，并随 VS Code 当前主题自动切换。

> Vditor 会直接把 `#app` 元素变为编辑器根节点，因此根选择器应写成 `#app.vditor`，而不是表示后代元素的 `#app .vditor`。本目录所有主题和内置模板均已使用正确选择器。

## 文件

- `dark-midnight-neon.css`：深海蓝黑与青紫霓虹配色，层次清晰，适合代码和技术文档。
- `dark-graphite-ember.css`：低饱和暖黑与琥珀色配色，适合长时间写作。
- `light-paper-day.css`：暖白纸张与蓝绿色配色，标题使用书刊风格字体。

这三套样式是可选的工作区主题，不计入两套内置默认主题。它们均覆盖编辑区、分屏预览、工具栏、菜单、目录、标题、引用、表格、代码高亮、媒体和滚动条；不会修改插件自身的布局尺寸。
