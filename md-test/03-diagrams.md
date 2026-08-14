# 图表与特殊代码块渲染测试

## 1. Mermaid

### 1.1 流程图

```mermaid
flowchart TD
    A([开始]) --> B{文件存在吗？}
    B -- 是 --> C[读取 Markdown]
    B -- 否 --> D[创建测试文档]
    C --> E[渲染预览]
    D --> E
    E --> F{渲染成功？}
    F -- 是 --> G([完成])
    F -- 否 --> H[显示错误信息]
    H --> C
```

### 1.2 时序图

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant Webview
    participant Extension as Extension Host
    participant Document as TextDocument
    User->>Webview: 编辑 Markdown
    Webview->>Extension: update(content, version)
    Extension->>Document: applyEdit()
    Document-->>Extension: 新版本
    Extension-->>Webview: acknowledge(version)
    Webview-->>User: 显示同步结果
```

### 1.3 类图

```mermaid
classDiagram
    class MarkdownEditor {
        +String mode
        +open(file)
        +save()
        +render()
    }
    class TextDocument {
        +Uri uri
        +Number version
        +getText()
    }
    class Webview {
        +postMessage(message)
        +onDidReceiveMessage(handler)
    }
    MarkdownEditor --> TextDocument : edits
    MarkdownEditor --> Webview : hosts
```

### 1.4 状态图

```mermaid
stateDiagram-v2
    [*] --> Loading
    Loading --> Ready: 初始化成功
    Loading --> Error: 初始化失败
    Ready --> Editing: 用户输入
    Editing --> Saving: 保存
    Saving --> Ready: 写入成功
    Saving --> Conflict: 外部修改重叠
    Conflict --> Editing: 保留编辑器内容
    Conflict --> Ready: 接受外部内容
    Error --> Loading: 重试
```

### 1.5 ER 图

```mermaid
erDiagram
    DOCUMENT ||--o{ REVISION : has
    DOCUMENT ||--o{ ASSET : references
    USER ||--o{ DOCUMENT : edits
    DOCUMENT {
        string path PK
        string title
        int version
    }
    REVISION {
        int id PK
        datetime created_at
        string content_hash
    }
    ASSET {
        int id PK
        string type
        string relative_path
    }
```

### 1.6 甘特图

```mermaid


gantt
    title Markdown 插件测试计划
    dateFormat  YYYY-MM-DD
    axisFormat  %m-%d
    section 准备
    编写测试文档        :done, docs, 2026-08-13, 1d
    准备图片资源        :done, assets, after docs, 1d
    section 验证
    检查基础 Markdown   :active, basic, after assets, 2d
    检查图表和公式      :diagram, after basic, 2d
    回归验证            :regression, after diagram, 1d
```





### 1.7 饼图

```mermaid
pie showData
    title 测试内容占比
    "基础 Markdown" : 35
    "代码块" : 25
    "图表" : 25
    "媒体与 HTML" : 15
```

### 1.8 Git 提交图

```mermaid
gitGraph
    commit id: "init"
    branch feature
    checkout feature
    commit id: "docs"
    commit id: "tests"
    checkout main
    merge feature id: "merge"
    commit id: "release"
```

### 1.9 Mermaid 思维导图

```mermaid
mindmap
  root((Markdown))
    文本
      标题
      列表
      表格
    扩展
      数学公式
      GitHub Alerts
      图表
    媒体
      图片
      HTML
```

> 如果 Git 图或思维导图无法显示，而前面的 Mermaid 图可以显示，请记录所加载 Mermaid 版本及对应语法支持情况。

## 2. Graphviz（Vditor 扩展）

```graphviz
digraph MarkdownPipeline {
  rankdir=LR;
  node [shape=box, style="rounded,filled", fillcolor="#dbeafe", color="#2563eb"];
  Source [label="Markdown Source"];
  Parser [label="Lute Parser", shape=ellipse, fillcolor="#ede9fe", color="#7c3aed"];
  Preview [label="Rendered Preview", fillcolor="#dcfce7", color="#16a34a"];
  Save [label="VS Code TextDocument", fillcolor="#fef3c7", color="#d97706"];
  Source -> Parser [label="parse"];
  Parser -> Preview [label="render"];
  Source -> Save [label="sync"];
  Save -> Source [label="external update", style=dashed];
}
```

## 3. ECharts（Vditor 扩展）

### 3.1 柱状图与折线图

```echarts
{
  "title": { "text": "每类测试数量", "left": "center" },
  "tooltip": { "trigger": "axis" },
  "legend": { "data": ["通过", "总数"], "top": 30 },
  "xAxis": {
    "type": "category",
    "data": ["基础", "代码", "图表", "公式", "HTML"]
  },
  "yAxis": { "type": "value", "minInterval": 1 },
  "series": [
    {
      "name": "通过",
      "type": "bar",
      "data": [12, 27, 8, 10, 9],
      "itemStyle": { "color": "#3b82f6" }
    },
    {
      "name": "总数",
      "type": "line",
      "data": [12, 30, 9, 10, 10],
      "smooth": true
    }
  ]
}
```

### 3.2 环形图

```echarts
{
  "title": { "text": "渲染状态", "left": "center" },
  "tooltip": { "trigger": "item" },
  "series": [
    {
      "name": "状态",
      "type": "pie",
      "radius": ["40%", "70%"],
      "data": [
        { "value": 82, "name": "通过" },
        { "value": 12, "name": "待检查" },
        { "value": 6, "name": "失败" }
      ]
    }
  ]
}
```

## 4. flowchart.js

```flowchart
st=>start: 开始
input=>inputoutput: 输入 Markdown
parse=>operation: 解析文档
check=>condition: 是否成功？
preview=>operation: 显示预览
error=>operation: 显示错误
end=>end: 结束

st->input->parse->check
check(yes)->preview->end
check(no)->error->input
```

## 6. Markmap

```markmap
# Markdown Interactor

## 编辑

- WYSIWYG
- Split View
  - 源码
  - 实时预览

## 内容

- 基础 Markdown
  - 标题
  - 列表
  - 表格
- 扩展语法
  - KaTeX
  - Mermaid
  - GitHub Alerts

## 输出

- Markdown
- HTML
```

## 8. ABC 乐谱

```abc
X:1
T:Markdown Render Test
M:4/4
L:1/8
Q:1/4=120
K:C
|: C2 E2 G2 c2 | c2 G2 E2 C2 | F2 A2 c2 A2 | G8 :|
```

预期：显示一小段五线谱，而不是普通文本代码块。
