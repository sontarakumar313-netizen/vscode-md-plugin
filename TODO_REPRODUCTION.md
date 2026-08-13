# TODO 修复前复现记录

记录时间：2026-08-13

## 基线环境

- VS Code：1.133.0 x64
- Vditor：3.11.2
- 平台：Windows
- 编辑器模式：WYSIWYG / SV
- 基线验证：`npm run typecheck`、`npm run build` 通过
- 使用真实 Extension Development Host（非普通浏览器）复现剪切问题；其余 UI 项同时通过 Chromium Webview 基线页和静态配置核对。

## 1. WYSIWYG 无法剪切

### 复现步骤

1. 在 Extension Development Host 中打开 Markdown Interactor。
2. 文档内容设为 `alpha beta`。
3. 在 WYSIWYG 中选中 `alpha`。
4. 按 `Ctrl+X`。

### 预期结果

- 剪贴板写入 `alpha`。
- 编辑器和 Markdown 删除 `alpha`，剩余 ` beta`。
- 操作可以一次撤销。

### 实际结果

- 选区仍为 `alpha`。
- WYSIWYG 文本和 `vditor.getValue()` 都仍是 `alpha beta`，没有发生删除。
- 同一基线在普通 Headless Chrome 中能删除，说明问题与 VS Code Webview/Electron 对旧编辑命令的支持差异有关。

### 根因

Vditor 3.11.2 的 `cutEvent` 先写剪贴板，再仅调用 `document.execCommand('delete')`。VS Code Webview 中该删除命令没有生效，Vditor没有检查返回值，也没有 Range 删除回退，因此剪切退化成复制。

## 2. 标题左侧等级不可操作

### 复现步骤

1. 打开包含 `# Heading` 的文档。
2. 将鼠标移到标题左侧 `H1`。
3. 尝试点击或使用键盘聚焦。

### 预期结果

左侧等级可打开 H1～H6 菜单并修改标题等级。

### 实际结果

- `H1` 来自 `h1::before`，计算内容为 `"H1"`。
- 标题内不存在按钮或带 `role="button"` 的元素，无法点击、聚焦或提供菜单。

### 根因

当前等级只是 Vditor CSS 伪元素，不是 DOM 控件；项目也没有标题等级控制器。

## 3. 顶部工具栏提示缺失

### 复现步骤

1. 将 Webview 宽度缩小到 520px 以下。
2. 依次悬浮或键盘聚焦顶部按钮。

### 预期结果

每个一级按钮都显示位于视口内的提示；打开下拉菜单后该按钮提示关闭。

### 实际结果

- 按钮大多有 `aria-label`，但 Vditor 在 `max-width: 520px` 下把 tooltip 的 `::before/::after` 设置为 `content: none`。
- 基线计算样式中所有顶部 tooltip 的伪元素内容与显示均为 `none`。
- 多数按钮仍使用向上的 `n` 方向，而固定工具栏位于视口顶部；右侧下拉按钮使用向右的 `e` 方向，容易越界。

### 根因

缺少针对固定顶部工具栏的方向策略和窄窗口覆盖规则，也没有在下拉菜单打开时抑制 `:hover` tooltip。

## 4. 公式背景没有始终继承文档背景

### 复现步骤

1. 在深色主题打开同时包含 `$x+1$` 和 `$$ y^2 $$` 的文档。
2. 检查行内与行间公式及其预览包装层背景。
3. 再应用 `00-styles` 中任一示例主题。

### 预期结果

行内和行间公式渲染面始终透明，直接显示文档背景。

### 实际结果

- 行内 `.language-math` 本身透明。
- 行间公式的预览父层在深色基线中计算为 `rgb(13, 17, 23)`，并非文档透明背景。
- 三套 `00-styles` 都把 `.language-math` 与图表共用有填充背景、边框和内边距的规则。

### 根因

公式没有独立于代码/图表预览的透明背景规则，示例主题也把公式纳入通用富预览填充选择器。

## 5. VSIX README 链接错误

### 复现步骤

1. 对比 Git 远端和 `package.json` 仓库元数据。
2. 检查 `.vscodeignore` 与 README 中的相对链接。

### 预期结果

VSIX 详情页中的仓库、Issues、logo、样式、CHANGELOG 和 LICENSE 链接均指向实际可访问位置。

### 实际结果

- 实际远端为 `sontarakumar313-netizen/vscode-md-plugin`。
- `package.json` 的 homepage、bugs、repository 仍指向 `vscode-md-interactor`。
- README 的 `00-styles`、CHANGELOG 等使用相对链接，而 `00-styles` 被排除在 VSIX 外。

### 根因

仓库更名后包元数据未同步；README 假定链接目标与仓库文件都存在于扩展包中。

## 6. 顶部功能区快捷键不可统一配置并可能穿透

### 复现步骤

1. 检查扩展设置，尝试为自定义公式、Alert、详情、模式切换等按钮修改快捷键。
2. 在 WYSIWYG/SV 中触发 Vditor 默认快捷键，并观察事件传播。

### 预期结果

所有工具栏操作使用一个可校验、可热更新的配置入口；命中后仅执行一次按钮动作且不继续触发 VS Code。

### 实际结果

- 扩展没有 `toolbarShortcuts` 或等价设置。
- Vditor 为部分内置按钮硬编码快捷键，自定义按钮没有统一支持。
- 基线 `Ctrl+I` 虽被 Vditor处理并 `preventDefault()`，仍到达 document 冒泡监听器；项目只对 `Ctrl+B` 和私有模式组合做了零散防护。
- `Ctrl+M` 同时出现在 Vditor 表格快捷键和项目“Tab 移动焦点”策略中。

### 根因

快捷键定义、动作分发和事件隔离分散在 Vditor及项目监听器中，没有稳定操作 ID、配置校验、冲突检测或统一的捕获阶段控制器。

## 测试基础设施现状

按审核通过的方案，从提交 `8656f30` 之前恢复了被删除的 `scripts/test-*.js` 与 fixtures。恢复后的 Webview 交互测试在基线阶段因语言环境相关的旧断言（期望中文 `Alert 内容`，当前测试浏览器实际为英文 `Alert content`）提前失败；该问题与本次六项功能无关，实施时会把断言改为与浏览器语言无关，再增加本次回归用例。
