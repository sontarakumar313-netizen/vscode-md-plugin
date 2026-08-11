import { copyFile, cp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, context } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = resolve(root, 'media', 'dist')
const watch = process.argv.includes('--watch')
const vditorPackage = JSON.parse(
  await readFile(
    resolve(root, 'media-src', 'node_modules', 'vditor', 'package.json'),
    'utf8'
  )
)

if (!watch) {
  await rm(outputDirectory, { recursive: true, force: true })
}
await mkdir(outputDirectory, { recursive: true })

const vditorDistDirectory = resolve(
  root,
  'media-src',
  'node_modules',
  'vditor',
  'dist'
)

// Vditor fetches its Markdown parser from unpkg.com unless a local copy is
// supplied. Emitting it next to main.js lets media-src/src/main.ts resolve it
// from its own script URL, so a freshly opened editor parses Markdown with no
// network access and a compromised CDN cannot replace the parser. Renderers
// Vditor only loads on demand (KaTeX, Mermaid, highlight.js) still use the CDN.
await copyFile(
  resolve(vditorDistDirectory, 'js', 'lute', 'lute.min.js'),
  resolve(outputDirectory, 'lute.min.js')
)

// Most emoji shortcodes parse to Unicode text, but Lute renders 18 of them as
// images from whatever emoji site it is given, including :octocat: and
// :trollface:. Those are ordinary GitHub-flavored Markdown, so the images ship
// with the extension instead of being fetched per document.
await cp(
  resolve(vditorDistDirectory, 'images', 'emoji'),
  resolve(outputDirectory, 'emoji'),
  { recursive: true }
)

const i18nAssignment = /^\s*window\.VditorI18n\s*=\s*/

// The locale bundles are plain `window.VditorI18n = {...}` scripts that Vditor
// would otherwise load from the CDN one language at a time. All of them together
// are a few dozen kilobytes, so inlining every language keeps a locale added to
// media-src/src/lang.ts from silently reintroducing a network fetch.
const vditorI18nPlugin = {
  name: 'vditor-i18n',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^virtual:vditor-i18n$/ }, () => ({
      path: 'virtual:vditor-i18n',
      namespace: 'vditor-i18n',
    }))
    pluginBuild.onLoad({ filter: /.*/, namespace: 'vditor-i18n' }, async () => {
      const directory = resolve(vditorDistDirectory, 'js', 'i18n')
      const files = (await readdir(directory)).filter((file) =>
        file.endsWith('.js')
      )
      if (files.length === 0) {
        throw new Error(`No Vditor locale bundles found in ${directory}`)
      }
      const entries = await Promise.all(
        files.map(async (file) => {
          const source = await readFile(resolve(directory, file), 'utf8')
          if (!i18nAssignment.test(source)) {
            throw new Error(
              `${file} no longer assigns window.VditorI18n; ` +
                'update the vditor-i18n plugin in scripts/build-media.mjs'
            )
          }
          const literal = source
            .replace(i18nAssignment, '')
            .trim()
            .replace(/;$/, '')
          return `  ${JSON.stringify(basename(file, '.js'))}: ${literal}`
        })
      )
      return {
        contents: `export const vditorI18n = {\n${entries.join(',\n')}\n}\n`,
        loader: 'js',
        resolveDir: directory,
      }
    })
  },
}

const options = {
  absWorkingDir: root,
  entryPoints: [resolve(root, 'media-src', 'src', 'main.ts')],
  bundle: true,
  minify: !watch,
  sourcemap: true,
  // Vditor's TypeScript sources expect its own build pipeline to inject this
  // compile-time constant. Without it, the webview fails before initialization.
  define: {
    VDITOR_VERSION: JSON.stringify(vditorPackage.version),
  },
  plugins: [vditorI18nPlugin],
  outfile: resolve(outputDirectory, 'main.js'),
  logLevel: 'info',
}

if (watch) {
  // Keep the last complete bundle available while the watcher starts. VS Code
  // may open the extension as soon as the TypeScript watcher reports ready.
  await build(options)
  const buildContext = await context(options)
  await buildContext.watch()
  console.log('Watching media-src for changes...')
} else {
  await build(options)
}
