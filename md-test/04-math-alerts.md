# 数学公式与 GitHub Alerts 测试

## 1. 行内公式

预期：以下公式与正文位于同一行，且上下标不会导致异常的行高或背景色。

- 勾股定理：$a^2 + b^2 = c^2$
- 欧拉恒等式：$e^{i\pi} + 1 = 0$
- 求和：$S_n = \sum_{k=1}^{n} k = \frac{n(n+1)}{2}$
- 希腊字母：$\alpha, \beta, \gamma, \Delta, \Omega$
- 行内矩阵：$A = \begin{pmatrix} a & b \\ c & d \end{pmatrix}$

价格文本使用转义避免误判：商品价格为 \$5，折扣后为 \$4。预期显示普通美元金额而不是公式。

## 2. 块级公式

### 2.1 二次方程

$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$

### 2.2 积分

$$
\int_{-\infty}^{+\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

### 2.3 分段函数

$$
f(x) =
\begin{cases}
x^2, & x \ge 0 \\
-x, & x < 0
\end{cases}
$$

### 2.4 矩阵

$$
\mathbf{A} =
\begin{bmatrix}
1 & 2 & 3 \\
4 & 5 & 6 \\
7 & 8 & 9
\end{bmatrix}
$$

### 2.5 对齐公式

$$
\begin{aligned}
(a+b)^2 &= a^2 + 2ab + b^2 \\
(a-b)^2 &= a^2 - 2ab + b^2
\end{aligned}
$$

### 2.6 化学式样式

$$
\mathrm{H_2O} \qquad \mathrm{CO_2} \qquad \mathrm{C_6H_{12}O_6}
$$

### 2.7 `math` 围栏

GitHub 使用 MathJax 渲染 `math` 围栏，当前插件由 Vditor 使用 KaTeX 渲染。

```math
\displaystyle
P(A \mid B) = \frac{P(B \mid A)\,P(A)}{P(B)}
```

> [!IMPORTANT]
> GitHub 与当前插件共同测试 `$...$`、`$$...$$` 和 `math` 围栏。本文件不使用 `\(...\)` 或 `\[...\]`。

## 3. GitHub Alerts

### 3.1 NOTE

> [!NOTE]
> 这是普通说明信息。
>
> 第二段包含 **粗体**、*斜体*、`行内代码` 和 [链接](https://example.com)。

### 3.2 TIP

> [!TIP]
> 这是建议或小技巧。
>
> - 技巧一：检查浅色主题
> - 技巧二：检查深色主题

### 3.3 IMPORTANT

> [!IMPORTANT]
> 这是需要特别注意的重要信息。
>
> 数学内容也应正常显示：$E = mc^2$。

### 3.4 WARNING

> [!WARNING]
> 这是警告信息。
>
> ```bash
> echo "alert 中的代码块"
> ```

### 3.5 CAUTION

> [!CAUTION]
> 这是表示潜在风险的提示信息。
>
> 1. 阅读说明
> 2. 备份数据
> 3. 再执行操作

## 4. 连续 Alerts

> [!NOTE]
> 第一个 Alert。

> [!TIP]
> 第二个 Alert，中间只有一个空行。

> [!WARNING]
> 第三个 Alert。三个块应相互独立，不应合并。

## 5. 普通引用对照组

> 这是普通 Blockquote，没有 `[!TYPE]` 标记，不应获得 GitHub Alert 的标题或颜色。

预期：NOTE、TIP、IMPORTANT、WARNING、CAUTION 五种类型具有不同图标或强调色；普通引用保持普通引用样式。
