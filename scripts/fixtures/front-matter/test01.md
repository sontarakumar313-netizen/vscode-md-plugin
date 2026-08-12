---
title: Front Matter 基础字段测试
description: 测试 VS Code 和 Markdown Interactor 的基础 Front Matter 展示
status: active
draft: false
priority: 1
---

# 基础字段测试

## 操作

1. 在 VS Code 内置 Markdown Preview 中打开本文。
2. 在 Markdown Interactor 中分别打开 WYSIWYG 和 Split View。
3. 对比 `title`、`description`、`status`、`draft` 和 `priority`。
4. 保存一次，再重新打开。

## 预期

- 两个编辑器都识别文档开头的 Front Matter。
- 默认表格展示中的字段和值一致。
- Front Matter 不会作为普通正文显示。
- 保存和重新打开后内容仍然存在。

- [ ] VS Code 通过
- [ ] WYSIWYG 通过
- [ ] Split View 通过

问题备注：
