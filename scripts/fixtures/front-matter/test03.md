---
title: YAML 数据类型测试
integerValue: 42
floatValue: 4.5
booleanTrue: true
booleanFalse: false
nullValue: null
dateValue: 2026-08-10
emptyValue:
---

# YAML 数据类型测试

## 操作

逐项比较以下值在 VS Code Preview 和 Markdown Interactor 中的含义：

| 字段 | 预期类型 |
| --- | --- |
| `integerValue` | 整数 |
| `floatValue` | 浮点数 |
| `booleanTrue` | 布尔值 `true` |
| `booleanFalse` | 布尔值 `false` |
| `nullValue` | 空值 |
| `dateValue` | 日期值或日期字符串 |
| `emptyValue` | 空值 |

## 预期

不能把 `false`、数字或 `null` 错误地转换成普通文本，也不能在保存时丢失小数部分。

- [ ] VS Code 通过
- [ ] Markdown Interactor 通过

问题备注：
