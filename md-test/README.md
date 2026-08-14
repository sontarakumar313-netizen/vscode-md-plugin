# Markdown Interactor 与 GitHub Markdown 渲染测试集

这组文档以 **GitHub Flavored Markdown（GFM）** 和当前插件内置的 **Vditor 3.11.2 扩展能力** 为范围，用于人工检查 Markdown Interactor 在 **可视化编辑（WYSIWYG）** 和 **源码分屏（Split View）** 下的渲染、编辑与保存行为。

> [!NOTE]
> 建议依次在 Markdown Interactor 和 GitHub 中打开每个文件，对比浅色/深色主题、两种编辑模式，以及保存后重新打开的结果。Vditor 自带但 GitHub 不渲染的图表仍予保留，并在文档中明确标注。

## 测试文档

| 文档 | 主要测试内容 |
| --- | --- |
| [01-basic.md](./01-basic.md) | Front Matter、标题、文本样式、链接、引用、列表、表格、脚注 |
| [02-code-blocks.md](./02-code-blocks.md) | 无语言代码块及多种编程语言的语法高亮 |
| [03-diagrams.md](./03-diagrams.md) | Mermaid、GeoJSON、TopoJSON、STL，以及 Vditor 自带的 Graphviz、ECharts、PlantUML 等扩展 |
| [04-math-alerts.md](./04-math-alerts.md) | GitHub/插件通用数学语法、五种 GitHub Alerts |
| [05-media-html.md](./05-media-html.md) | 本地/远程/失效图片和 GitHub 允许的安全 HTML 子集 |

## 支持范围对照

| 功能 | GitHub | 当前插件 |
| --- | :---: | :---: |
| GFM 基础语法、表格、任务列表、脚注 | ✅ | ✅ |
| 多语言围栏代码块 | ✅ | ✅ |
| Mermaid | ✅ | ✅（Vditor） |
| GeoJSON、TopoJSON、STL | ✅ | ⚠️ 当前按普通代码块显示 |
| Graphviz、ECharts、flowchart.js | ❌ | ✅（Vditor） |
| Mindmap、Markmap、PlantUML、ABC、SMILES | ❌ | ✅（Vditor） |
| `$...$`、`$$...$$`、`math` 围栏 | ✅（MathJax） | ✅（KaTeX/Vditor） |
| 五种 GitHub Alerts | ✅ | ✅ |
| GitHub 允许的安全 HTML 子集 | ✅ | ✅，清理规则可能略有差异 |

## 建议检查流程

1. 使用 **Markdown Interactor Editor** 打开测试文档。
2. 在 WYSIWYG 模式下检查排版、图表和交互组件。
3. 切换到源码分屏模式，确认源码与右侧预览一致。
4. 修改一处文本、任务状态、表格或代码，再保存文件。
5. 关闭并重新打开文件，确认内容没有被意外改写。
6. 切换 VS Code 浅色和深色主题，检查文字、边框及图表的可读性。
7. 使用“复制 Markdown”和“复制 HTML”，检查复制结果。

## 总体检查清单

- [ ] 标题层级和文档目录正确
- [ ] 粗体、斜体、删除线、行内代码等文本样式正确
- [ ] 相对链接、锚点和外部链接可点击
- [ ] 有序、无序、嵌套及任务列表正确
- [ ] 表格对齐正确，右键表格操作可用
- [ ] 普通代码块高亮且可以原位编辑
- [ ] Mermaid 和 Vditor 特殊代码块渲染为图表而非普通代码
- [ ] GitHub 原生 GeoJSON、TopoJSON、STL 测试块不会破坏插件布局
- [ ] 数学公式清晰且没有背景色异常
- [ ] 五种 GitHub Alerts 样式和类型正确
- [ ] 本地图片可见，远程媒体开关生效
- [ ] `<details>` 可展开/折叠，允许的 HTML 正常显示
- [ ] 保存和重新载入后 Markdown 语义不变

## 说明

- `03-diagrams.md` 中的 Vditor 扩展图表需要从 Vditor CDN 加载脚本；PlantUML 还需要访问 PlantUML 在线服务。离线时这些项目可能无法完成渲染。
- GitHub 原生支持 GeoJSON、TopoJSON 和 STL；当前插件没有对应的富渲染器，显示为普通代码块属于已知兼容性差异。
- `05-media-html.md` 故意包含一个不存在的图片地址，用于检查失败占位和替代文本。
- GitHub 和插件都会清理不安全 HTML，但两者的允许列表可能存在细微差异。
- 本测试集以人工检查为主，不应把已标注的平台差异直接视为插件缺陷。
