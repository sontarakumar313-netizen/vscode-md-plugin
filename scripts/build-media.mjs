import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, context } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = resolve(root, 'media', 'dist')
const watch = process.argv.includes('--watch')
const vditorPackageDirectory = resolve(
  root,
  'media-src',
  'node_modules',
  'vditor'
)
const vditorPackage = JSON.parse(
  await readFile(resolve(vditorPackageDirectory, 'package.json'), 'utf8')
)

if (!watch) {
  await rm(outputDirectory, { recursive: true, force: true })
}
await mkdir(outputDirectory, { recursive: true })
// Emoji shortcodes are intentionally unsupported. Remove assets left by an
// older build even in watch mode, where the rest of dist remains in place.
await rm(resolve(outputDirectory, 'emoji'), { recursive: true, force: true })

const vditorDistDirectory = resolve(vditorPackageDirectory, 'dist')

// Vditor fetches its Markdown parser from unpkg.com unless a local copy is
// supplied. Ship the parser from the pinned official package next to main.js so
// media-src/src/main.ts can resolve it without network access. Renderers Vditor
// only loads on demand (KaTeX, Mermaid, highlight.js) still use the CDN.
await Promise.all([
  copyFile(
    resolve(vditorDistDirectory, 'js', 'lute', 'lute.min.js'),
    resolve(outputDirectory, 'lute.min.js')
  ),
  copyFile(
    resolve(root, 'media-src', 'vendor', 'lute.LICENSE.txt'),
    resolve(outputDirectory, 'lute.LICENSE.txt')
  ),
])

const i18nAssignment = /^\s*window\.VditorI18n\s*=\s*/

// Build from the pinned package's official TypeScript entry so Vditor and this
// extension's deep utility imports share one module graph. The package's source
// entry imports Less that is already present as dist/index.css, and its CommonJS
// diff dependency uses legacy TypeScript import syntax; handle those two build
// compatibility details without modifying the installed package.
const vditorSourcePlugin = {
  name: 'vditor-source',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^vditor$/ }, () => ({
      path: resolve(vditorPackageDirectory, 'src', 'index.ts'),
    }))
    pluginBuild.onResolve({ filter: /\.less$/ }, () => ({
      path: 'vditor-styles',
      namespace: 'vditor-styles',
    }))
    pluginBuild.onLoad(
      { filter: /.*/, namespace: 'vditor-styles' },
      () => ({ contents: '', loader: 'empty' })
    )
    pluginBuild.onLoad(
      { filter: /[\\/]vditor[\\/]src[\\/]ts[\\/]undo[\\/]index\.ts$/ },
      async (args) => {
        const source = await readFile(args.path, 'utf8')
        const compatible = source.replace(
          'import * as DiffMatchPatch from "diff-match-patch";',
          'import DiffMatchPatch from "diff-match-patch";'
        )
        if (compatible === source) {
          throw new Error(
            'Vditor undo import changed; update the compatibility transform in scripts/build-media.mjs'
          )
        }
        return { contents: compatible, loader: 'ts' }
      }
    )
  },
}

// Lute starts with roughly 1,500 built-in emoji shortcodes. Replace that map
// before Vditor renders any document so strings such as :smile: and :octocat:
// remain literal Markdown and never trigger an image request.
const disableVditorEmojiPlugin = {
  name: 'disable-vditor-emoji',
  setup(pluginBuild) {
    pluginBuild.onLoad(
      { filter: /[\\/]vditor[\\/]src[\\/]ts[\\/]markdown[\\/]setLute\.ts$/ },
      async (args) => {
        const source = await readFile(args.path, 'utf8')
        const withoutEmoji = source.replace(
          'lute.PutEmojis(options.emojis);',
          'lute.SetEmojis({});'
        )
        if (withoutEmoji === source) {
          throw new Error(
            'Vditor emoji initialization changed; update the disable-vditor-emoji plugin in scripts/build-media.mjs'
          )
        }
        return { contents: withoutEmoji, loader: 'ts' }
      }
    )
  },
}

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
  tsconfig: resolve(root, 'media-src', 'tsconfig.json'),
  minify: !watch,
  sourcemap: true,
  // Vditor's TypeScript sources expect its own build pipeline to inject this
  // compile-time constant. Without it, the webview fails before initialization.
  define: {
    VDITOR_VERSION: JSON.stringify(vditorPackage.version),
  },
  plugins: [
    vditorSourcePlugin,
    disableVditorEmojiPlugin,
    vditorI18nPlugin,
  ],
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
