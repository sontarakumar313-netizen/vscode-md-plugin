---
title: Unclosed Front Matter
 tags:
  - markdown

# 未闭合 Front Matter 测试

这个文件故意没有结束的 `---`。

## 预期

- 不应把整个剩余文档静默吞掉；
- 两个编辑器对未闭合块的处理结果应一致；
- 内容仍然可以查看和编辑。

- [ ] VS Code 通过
- [ ] Markdown Interactor 通过

问题备注：
