---
title: [unclosed
items:
  - first
  - second
---

# 非法 YAML 测试

## 预期

- 两个编辑器都识别 Front Matter 的边界；
- YAML 解析失败时显示清晰错误，或明确标记该块无效；
- 原始错误内容不能被静默删除；
- 正文仍然可以查看。

- [ ] VS Code 错误行为通过
- [ ] Markdown Interactor 错误行为通过
- [ ] 错误源码保持完整

问题备注：
