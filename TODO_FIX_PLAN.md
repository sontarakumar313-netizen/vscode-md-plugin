# TODO 修复方案

## 目标

处理 `TODO.md` 中的四项需求，并以 `test.md` 的 OpenScreen 片段作为主要回归样本。修改应保持 Markdown 原文可逆，不向文件中写入仅用于展示或编辑的 DOM，并继续适配 VS Code/工作区主题。

## 当前问题初步定位

### 1. OpenScreen 文档渲染

`test.md` 开头同时包含以下边界输入：

- 混合大小写 GitHub Alert：`[!Note]`。
- 多个 `<p align="center">` 原生 HTML 块。
- 标题中的内联 HTML：`# <p align="center">OpenScreen</p>`。
- HTML `<a><img></a>` 形式的 Trendshift 图片链接。
- 第一组 HTML 中存在额外的 `</a>`，Lute 会把它拆成独立 HTML block。

混合大小写 Alert 已由 GitHub Alert 兼容修复覆盖。剩余问题主要集中在 Lute 的 HTML block/inline HTML WYSIWYG 投影、HTML preview 背景，以及 HTML 图片链接点击拦截。

修复前需在真实 Webview 中记录：

1. 打开 `test.md`。
2. 对比 GitHub 实际渲染与 WYSIWYG 渲染。
3. 分别记录 Alert、居中标题、居中图片块、Trendshift 图片链接的实际 DOM。
4. 区分插件问题与源文件中多余 `</a>` 导致的 HTML 容错差异；不得通过静默重写用户 Markdown 来掩盖无效 HTML。

## 交互与实现方案

### 一、HTML 展示兼容层

新增一个职责单一的 WYSIWYG HTML 展示控制器，例如：

- `media-src/src/wysiwyg-html-presentation.ts`

控制器通过 `MutationObserver` 装饰 Lute 已生成的 DOM，只添加序列化忽略的 class/展示节点，不修改 HTML 源码。

#### 1. HTML block

针对：

```html
<p align="center">...</p>
```

以及其他带 `align` 的受支持块：

- 允许值：`left`、`center`、`right`、`justify`。
- 非法或未知值不应用额外投影。
- 保留浏览器对 `align` 的实际布局。
- 给对应 HTML preview 添加专用 class，避免影响普通 fenced code、公式和 Mermaid。
- preview 外层、直接内容和图片容器使用透明背景并继承正文颜色。
- 不改变图片自身背景、边框和显式 inline style。

建议 CSS 范围：

```css
.vditor-wysiwyg__block[data-type='html-block']
  > .vditor-wysiwyg__preview.vmd-html-transparent-preview
```

设置：

- `background-color: transparent !important`
- `background-image: none !important`
- `color: inherit`
- 必要时恢复正文 `font-family`，但不覆盖 HTML 内显式样式。

#### 2. 标题中的 `<p align>`

Lute 会把：

```markdown
# <p align="center">OpenScreen</p>
```

生成为 heading 中的两个 `code[data-type="html-inline"]` 标记，而不是可见 HTML 元素。

仅在同时满足以下条件时创建展示投影：

- heading 的首尾内联 HTML 恰好构成同一个 `<p align="...">...</p>`；
- `align` 值通过白名单校验；
- 中间仍有真实标题文本。

行为：

- 给 heading 添加 `vmd-html-align-*` class。
- 在视觉上隐藏首尾 HTML source token，但保留 serializer 所需 DOM。
- 标题文本按 `align` 对齐。
- 光标进入隐藏 token 附近时仍应能切换/查看原始 Markdown；如果无法可靠编辑，则只做展示对齐，不删除 token。
- 普通 inline HTML、未配对标签和任意属性不做特殊处理。

#### 3. 不修复源文件 HTML

`test.md` 中多余的 `</a>` 不应由插件自动删除。若 GitHub 与 Lute 对该无效 HTML 的容错结果不同，只修复安全的展示投影；保存后源文件必须保持不变。

### 二、代码块改为共享弹窗编辑

涉及文件：

- `media-src/src/wysiwyg-code-block.ts`
- `media-src/src/wysiwyg-popover.ts`
- `media-src/src/vditor-adapter.ts`
- `media-src/src/main.css`

#### 1. 打开方式

- 点击普通代码块预览或语言按钮时，不再展开 block 内的 `.vditor-wysiwyg__pre`。
- 拦截 Vditor 原生“源码显示在预览上方”的行为。
- 复用链接编辑使用的同一个 Vditor shared popover、定位逻辑、持久化逻辑、关闭按钮和 Escape 行为。
- Copy 按钮继续保留在代码块工具条中。
- 同一时间只能存在一个链接、图片、Details 标题或代码编辑弹窗。

#### 2. 弹窗结构

弹窗严格分为两行：

第一行：代码类型

- 单行 `<input>`。
- 不再限制为 `COMMON_LANGUAGES` 列表。
- 可输入 `tsx`、`vue`、`objective-c`、`c++`、自定义 lexer 名称等。
- 空值表示纯文本代码块。
- 输入值去除首尾空白。
- 禁止换行、控制字符和会破坏当前 fence 的反引号；非法值不写入文档，并显示可访问的错误状态。
- 用户未修改类型时保持原始拼写；确认修改后写入清理后的值。

第二行：代码内容

- 多行 `<textarea>`，使用编辑器等宽字体。
- 内容不包含 fence 行，也不包含 Vditor 为序列化附加的结构性尾换行。
- 保留用户代码中的内部换行、空行和缩进。
- 支持 IME composition，组合输入期间不提交或重渲染。

#### 3. 提交规则

建议采用“弹窗会话一次提交”的策略：

- 输入期间更新弹窗草稿，并以短 debounce 刷新预览。
- 关闭按钮、点击弹窗外部、Escape 或 `Ctrl/Cmd+Enter` 时提交当前合法草稿。
- 一次弹窗会话只产生一个 undo step。
- 若类型非法，则保持弹窗打开并聚焦类型输入框。
- 没有任何变化时关闭弹窗不得产生 edit/undo。
- 提交必须调用现有 Vditor commit 适配层，确保宿主同步、撤销和预览一致。
- 目标 block 被外部更新或模式切换替换时，应安全关闭弹窗，不得向已断开的 DOM 提交。

#### 4. 特殊语言

- 自由输入语言后，仍由 Vditor 判断是否转换为 Mermaid、PlantUML、Math 等 rich renderer。
- rich renderer 也不得重新打开占用文档区域的原生 source 面板。
- 如果异步 rich preview 尚未完成，弹窗应继续编辑 serializer-owned source，不能编辑渲染产物。

#### 5. 键盘与焦点

- 打开时优先聚焦代码内容；从语言按钮打开时聚焦语言输入。
- `Tab` 按正常表单顺序在类型、内容和关闭按钮之间移动，避免键盘焦点陷阱。
- `Escape` 关闭并按上述规则提交合法草稿。
- `Ctrl/Cmd+Enter` 提交并关闭。
- 关闭后恢复到原代码块或语言按钮，且不滚动页面。

### 三、HTML 居中内容背景透明

该项与 HTML 展示兼容层一起实现，不使用针对 README 文件名的特例。

验收范围：

- `README.md` 顶部 logo、标题、badge 和导航区域。
- `test.md` 的 OpenScreen logo、Trendshift badge、demo/sample 图片组。
- 浅色、深色、VS Code 主题色和 workspace CSS 下，HTML preview 均显示文档背景。
- fenced code block、inline code、公式和 Mermaid 背景不受影响。

### 四、Trendshift/GitHub 图片链接必须精确 Ctrl/Cmd+点击才跳转

涉及文件：

- `media-src/src/utils.ts`
- 必要时 `media-src/src/wysiwyg-popover.ts`
- `media-src/src/main.css`

#### 根因

当前捕获阶段对“WYSIWYG 中的 linked image + 普通点击”直接返回，依赖 Vditor 后续打开图片弹窗。Markdown 图片满足该假设，但 raw HTML preview 内的 `<a><img></a>` 不一定被 Vditor 接管，浏览器会继续执行 `target="_blank"` 的默认跳转。

#### 修复规则

- 所有 anchor，包括 raw HTML preview 中的 anchor，都在捕获阶段先执行 `preventDefault()` 和 `stopImmediatePropagation()`。
- 只有“精确主修饰键”才发送 `open-link`：
  - Windows/Linux：仅 `Ctrl`。
  - macOS：仅 `Cmd`。
  - `Ctrl/Cmd+Shift`、`Ctrl/Cmd+Alt` 等组合不得打开。
- `target="_blank"` 不得绕过该规则。
- Markdown 文本链接普通点击继续打开 URL 编辑弹窗。
- Markdown linked image 普通点击继续打开图片 URL/title 弹窗。
- raw HTML linked image 普通点击只阻止跳转；由于 href 属于 HTML source，不伪造 Markdown 链接编辑弹窗，也不重写 HTML。
- Ctrl/Cmd+点击 raw HTML linked image 时，通过现有 `open-link` 消息和宿主 URI 白名单打开，不能直接调用浏览器 `window.open()`。
- 按住精确修饰键时显示 pointer，否则 HTML linked image 使用默认/编辑态光标。

## 测试计划

### 回归 fixture

不要依赖主目录下未跟踪的 `test.md`。从中提取最小样本到受版本控制的测试 fixture，覆盖：

1. `[!Note]` 与 `[!WARNING]`。
2. `<p align="center">` 图片块。
3. `# <p align="center">Title</p>`。
4. `<a target="_blank"><img></a>`。
5. 多余 closing tag，确认保存不改写源文。
6. 普通代码块、自定义语言、空语言和 rich language。

### Webview 交互测试

在 `scripts/test-webview-interactions.js` 增加：

- HTML preview 及其居中内容的 computed background 为 transparent。
- heading HTML source token 不显示但 Markdown round-trip 不变。
- raw HTML linked image 普通点击不产生 `open-link`。
- raw HTML linked image 精确 Ctrl/Cmd+点击只产生一次 `open-link`。
- 带 Shift/Alt 的修饰点击不打开。
- 点击代码预览后 block 内 source 始终隐藏，共享 popover 可见。
- 代码弹窗恰好有一行语言输入和一行内容 textarea。
- 任意合法自定义语言可保存。
- 非法类型不能提交。
- 多行内容、空行、缩进和 IME 输入不丢失。
- 关闭后只产生一次 edit/undo，undo 可完整恢复。
- rich renderer 修改和异步重绘不会污染 Markdown。
- 切换模式、删除 block 或外部刷新时弹窗正确关闭。

### 单元测试

将纯逻辑抽离并测试：

- code language 校验与标准化。
- code source 的结构性尾换行拆装。
- HTML `align` 属性白名单解析。
- 精确主修饰键判断。

## 实施顺序

1. 复现并固定 OpenScreen 最小 fixture。
2. 修复 raw HTML linked image 点击逃逸，先消除意外外部跳转。
3. 实现 HTML preview 透明背景和 heading align 投影。
4. 抽取共享 popover 生命周期 API。
5. 将普通/特殊代码块编辑迁移到两行弹窗。
6. 删除旧语言固定菜单及不再使用的 CSS/状态代码。
7. 更新 `TODO.md` 勾选状态。
8. 运行完整验证。

## 验收命令

```bash
npm run typecheck
npm test
npm run build
```

另外执行：

```bash
git diff --check
```

若 Windows checkout 的 Front Matter fixture 仍因 CRLF 导致既有测试失败，需要单独记录环境问题，不应在本任务中顺手修改无关解析逻辑。

## 非目标

- 不自动修复或格式化用户原生 HTML。
- 不把 raw HTML anchor 转换成 Markdown anchor。
- 不改变 GitHub Alert 的视觉主题。
- 不对任意 HTML 属性开放脚本或危险 URI。
- 不顺手重构与上述四项无关的编辑器逻辑。
