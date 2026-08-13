---
title: 水平分隔线和外部同步测试
description: Front Matter 之后的水平分隔线不应被误判
tags:
  - horizontal-rule
  - external-update
---

# 水平分隔线和外部同步测试

Front Matter 之后的普通水平分隔线：

---

分隔线之后是普通正文。

## 外部同步

1. 在 Markdown Interactor 中打开本文并保持焦点。
2. 使用 VS Code 原生文本编辑器修改 `description`。
3. 观察插件的外部更新提示。
4. 载入外部修改后，再修改正文并保存。

## 预期

- 正文中的 `---` 只渲染为水平分隔线；
- 外部 Front Matter 修改不会导致编辑器清空；
- 插件保存正文时不会覆盖已经载入的外部 Front Matter；
- 发生重叠修改时，应提示冲突而不是静默覆盖。

- [ ] 水平分隔线通过
- [ ] 外部修改载入通过
- [ ] 冲突处理通过
- [ ] 保存后内容完整

问题备注：
