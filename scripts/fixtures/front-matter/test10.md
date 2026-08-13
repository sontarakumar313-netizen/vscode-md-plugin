 ---
title: Indented Marker
tags:
  - indented
---

# 缩进分隔线测试

第一行的 `---` 前面有一个空格，故意测试带缩进的 Front Matter 分隔线。

## 预期

- 带缩进的开头分隔线不应被识别为标准 Front Matter；
- 两个编辑器的处理结果应一致；
- 内容不能被静默删除。

- [ ] VS Code 通过
- [ ] Markdown Interactor 通过

问题备注：
