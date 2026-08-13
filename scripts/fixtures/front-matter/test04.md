---
title: 多行文本和特殊字符串测试
quotedColon: "value: contains a colon"
quotedHash: "value # is not a comment"
literalText: |
  第一行保留换行。
  第二行也保留换行。
foldedText: >
  这一段使用 YAML 折叠文本，
  普通换行通常会折叠为空格。
---

# 多行文本和特殊字符串测试

## 操作

对比带引号的冒号、带引号的 `#`、literal block 和 folded block 的展示结果。

## 预期

- 引号内的冒号不会被当成字段分隔符；
- 引号内的 `#` 不会被当成注释；
- `literalText` 的换行规则保持一致；
- `foldedText` 的折叠规则保持一致；
- 原始引号和缩进不会在无关编辑后被破坏。

- [ ] VS Code 通过
- [ ] Markdown Interactor 通过

问题备注：
