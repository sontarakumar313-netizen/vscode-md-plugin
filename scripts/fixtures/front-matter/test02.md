---
title: 数组和嵌套对象测试
tags:
  - markdown
  - vscode
  - compatibility
author:
  name: Markdown Interactor
  role: editor
  contact:
    email: test@example.com
    website: https://example.com
items:
  - name: first
    enabled: true
  - name: second
    enabled: false
---

# 数组和嵌套对象测试

## 操作

对比两个编辑器中 `tags`、`author` 和 `items` 的显示层级。

## 预期

- 数组中的每个项目都存在，顺序不变；
- `author.contact` 的嵌套关系不丢失；
- `items` 中的两个对象都能显示；
- 插件保存后不会把数组或对象压平成错误的字符串。

- [ ] VS Code 通过
- [ ] Markdown Interactor 通过

问题备注：
