import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { resolve } from 'node:path'

const outdir = resolve('dist/agent-staging')
await mkdir(outdir, { recursive: true })
const result = await build({
  entryPoints: {"facilitator":"apps/server/src/main.ts"},
  outdir, outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', target: 'node22', format: 'esm',
  // Some transitive CommonJS modules require Node built-ins at runtime.
  banner: { js: 'import { createRequire as __nodeCreateRequire } from "node:module"; const require = __nodeCreateRequire(import.meta.url);' },
  metafile: true, legalComments: 'eof', logLevel: 'info',
})
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (dependency.external && !isBuiltin(dependency.path)) {
      throw new Error('Non-portable dependency: ' + dependency.path)
    }
  }
}
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
await writeFile(resolve(outdir, 'version.json'), JSON.stringify({ revision, node: '22', chainId: 80002 }) + '\n')
