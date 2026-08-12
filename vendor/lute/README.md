# Two-mode Lute runtime

`lute.min.js` is a custom build of [Lute](https://github.com/88250/lute) `v1.7.6`
(commit `1f5951d8baaa29542bfa7c41415f4d68fa040202`) for Markdown Interactor.
It physically removes the unused instant-rendering parser/renderer APIs while
retaining the WYSIWYG and split-view APIs required by the extension.

The checked-in binary is copied to `media/dist/lute.min.js` by
`scripts/build-media.mjs`. Normal extension builds do not require Go.

## Rebuild

A reproducible rebuild needs:

- Go `1.18.10`;
- GopherJS `v1.18.0-beta3`;
- Git.

From a temporary directory:

```bash
git clone --depth 1 --branch v1.7.6 https://github.com/88250/lute.git lute
cd lute
git apply /path/to/vscode-md-plugin/vendor/lute/remove-ir.patch
cd javascript
GOOS=js GOARCH=ecmascript gopherjs build --tags javascript -o lute.min.js -m
```

On Windows, set the same `GOOS`/`GOARCH` values through PowerShell environment
variables before invoking `gopherjs.exe`. The reviewed binary has SHA-256
`573d0b641e1ef3ccc17a0d2b766440798c4c9c24d892b9511091f3d816caff45`.

Copy the result to `vendor/lute/lute.min.js`, then run:

```bash
pnpm build
pnpm test:two-mode-bundle
pnpm test:lute-reflow
pnpm test:webview-interactions
```

The upstream license is preserved in `LICENSE` and copied into the VSIX as
`media/dist/lute.LICENSE.txt`. The binary reports Lute version `1.7.6` at
runtime.
