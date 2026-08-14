# 多语言代码块渲染测试

> 预期：普通代码块显示语言名称或可用的语言菜单、语法高亮、复制入口和原位编辑区域。切换编辑模式及保存后，缩进和围栏不得改变。

## 1. 无语言与纯文本

无语言标识：

```
plain code block
中文不会被错误高亮
symbols: <div> { key: "value" } $HOME
```

纯文本：

```plaintext
Line 1: plain text
Line 2: https://example.com/?a=1&b=2
Line 3: []{}()<> !@#$%^&*
```

## 2. JavaScript 与 TypeScript

```javascript
const users = [{ id: 1, name: 'Ada' }, { id: 2, name: 'Linus' }]
const names = users.map(({ name }) => name)
console.log(`Users: ${names.join(', ')}`)
```

```typescript
interface User {
  readonly id: number
  name: string
  active?: boolean
}

const activate = (user: User): User => ({ ...user, active: true })
console.log(activate({ id: 1, name: 'Grace' }))
```

## 3. Web 标记与样式

```html
<article class="card" data-state="active">
  <h2>HTML code block</h2>
  <p title="escaped & safe">Hello <strong>world</strong>.</p>
</article>
```

```css
.card {
  display: grid;
  gap: 0.75rem;
  color: var(--vscode-editor-foreground, #222);
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
}

.card:hover { transform: translateY(-2px); }
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<catalog>
  <book id="md-01"><title>Markdown Test</title></book>
</catalog>
```

## 4. Python、Ruby、PHP 与 R

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class Point:
    x: float
    y: float

print(Point(3.0, 4.0))
```

```ruby
class Greeter
  def initialize(name)
    @name = name
  end

  def call = "Hello, #{@name}!"
end

puts Greeter.new('Markdown').call
```

```php
<?php
function greet(string $name): string {
    return "Hello, {$name}!";
}

echo greet('Markdown');
```

```r
values <- c(2, 4, 8, 16)
summary_table <- data.frame(index = seq_along(values), value = values)
print(summary_table)
```

## 5. Java、Kotlin 与 Scala

```java
import java.util.List;

public final class Example {
    public static void main(String[] args) {
        List<String> names = List.of("Ada", "Grace", "Linus");
        names.stream().map(String::toUpperCase).forEach(System.out::println);
    }
}
```

```kotlin
data class User(val id: Int, val name: String)

fun main() {
    val users = listOf(User(1, "Ada"), User(2, "Grace"))
    println(users.joinToString { it.name })
}
```

```scala
case class User(id: Int, name: String)

@main def run(): Unit = {
  val users = List(User(1, "Ada"), User(2, "Grace"))
  println(users.map(_.name).mkString(", "))
}
```

## 6. C、C++ 与 C#

```c
#include <stdio.h>

int main(void) {
    const int values[] = {1, 2, 3, 4};
    printf("count = %zu\n", sizeof values / sizeof values[0]);
    return 0;
}
```

```cpp
#include <iostream>
#include <vector>

int main() {
    const std::vector<int> values{1, 2, 3, 4};
    for (const auto value : values) std::cout << value << ' ';
}
```

```csharp
using System;
using System.Linq;

var squares = Enumerable.Range(1, 5).Select(value => value * value);
Console.WriteLine(string.Join(", ", squares));
```

## 7. Go 与 Rust

```go
package main

import "fmt"

func main() {
    values := []int{2, 4, 8, 16}
    for index, value := range values {
        fmt.Printf("%d: %d\n", index, value)
    }
}
```

```rust
fn main() {
    let values = [2, 4, 8, 16];
    let doubled: Vec<i32> = values.iter().map(|value| value * 2).collect();
    println!("{doubled:?}");
}
```

## 8. Swift

```swift
struct User: Codable {
    let id: Int
    let name: String
}

let users = [User(id: 1, name: "Ada"), User(id: 2, name: "Grace")]
print(users.map(\.name).joined(separator: ", "))
```

## 9. Shell 与 Bash

```bash
#!/usr/bin/env bash
set -euo pipefail

for file in ./*.md; do
  printf 'Markdown file: %s\n' "$file"
done
```

```shell
NAME="Markdown Interactor"
printf '%s\n' "Hello, ${NAME}"
```

## 10. JSON、YAML、TOML 与 INI

```json
{
  "name": "markdown-interactor",
  "enabled": true,
  "features": ["wysiwyg", "diagrams", "math"],
  "limits": { "uploadMB": 10, "count": 20 }
}
```

```yaml
name: markdown-interactor
enabled: true
features:
  - wysiwyg
  - diagrams
  - math
metadata:
  owner: "测试用户"
  version: 1
```

```toml
name = "markdown-interactor"
enabled = true
features = ["wysiwyg", "diagrams", "math"]

[limits]
upload_mb = 10
count = 20
```

```ini
[editor]
mode=wysiwyg
autosave=true

[theme]
name=dark
```

## 11. SQL

```sql
SELECT
    users.id,
    users.name,
    COUNT(tasks.id) AS task_count
FROM users
LEFT JOIN tasks ON tasks.user_id = users.id
WHERE users.active = TRUE
GROUP BY users.id, users.name
ORDER BY task_count DESC;
```



## 12. Diff

```diff
-const mode = "source";
+const mode = "wysiwyg";
 
-function render() {
-  return false;
+async function render() {
+  return await preview.update();
 }
```

## 13. Dockerfile 与 Makefile

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
```

```makefile
.PHONY: typecheck test build

typecheck:
	npm run typecheck

test:
	npm test

build:
	npm run build
```

## 14. Markdown 代码中的代码围栏

下面使用四个反引号包住 Markdown 示例，内部的三个反引号不得提前关闭外层代码块。

````markdown
# Markdown source example

- item one
- item two

```typescript
const nestedFence = true
```
````

## 15. 边界情况

空代码块：

```text
```

只有一个空行的代码块：

```text

```

长行（应横向滚动或安全换行，不应撑破整个 Webview）：

```javascript
const longMessage = 'This is an intentionally long line used to verify horizontal scrolling, wrapping policy, selection, copying, and editor layout without changing the original source content: 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz.'
```

包含容易与 HTML 混淆的字符：

```text
<script>alert("must remain text")</script>
<div class="test">& < > " '</div>
${template} {{ braces }} [link](not-a-link-here)
```

