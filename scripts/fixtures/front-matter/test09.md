<!-- 文件头注释，故意放在 Front Matter 之前 -->
---
title: Not At Document Start
tags:
  - not-front-matter
---

# Front Matter 不在第一行测试

## 预期

VS Code 的 Front Matter 规则要求分隔线位于文档第一行。插件不应因为后面出现成对的 `---`，就错误地把这部分识别为文档 Front Matter。

- [ ] VS Code 通过
- [ ] Markdown Interactor 通过

问题备注：
