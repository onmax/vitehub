import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { build } from "esbuild"
import { expect, it } from "vitest"
import { hubAgent } from "../src/vite.ts"

it("resets parent registry aliases once and preserves aliases across lazy Agent loads", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-lazy-url-registry-"))
  const packageRoot = fileURLToPath(new URL("..", import.meta.url))
  const artifact = join(packageRoot, "dist", `lazy-url-registry-${Date.now()}.mjs`)
  try {
    await mkdir(join(root, "server/agents"), { recursive: true })
    for (const name of ["first", "second"]) {
      await writeFile(join(root, "server/agents", `${name}.ts`), `export default { name: '${name}-explicit' }\n`)
    }
    const plugin = hubAgent()
    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      root, command: "build", plugins: [], build: { outDir: "dist" }, resolve: { alias: [] },
    })
    const registry = join(root, ".vitehub/agent/registry.mjs")
    const entry = join(root, "entry.ts")
    await writeFile(entry, `import { registerPublicUrlAgentName, resolvePublicUrl } from '@vite-hub/runtime'
export async function inspect() {
  registerPublicUrlAgentName('stale', 'first')
  const registry = (await import('#vitehub/agent/registry')).default
  await registry.first()
  await registry.second()
  return [resolvePublicUrl({ agentName: 'stale' }), resolvePublicUrl({ agentName: 'first-explicit' }), resolvePublicUrl({ agentName: 'second-explicit' })]
}`)
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
    await build({
      entryPoints: [entry], outfile: artifact, bundle: true, platform: "node", format: "esm", packages: "external",
      tsconfigRaw: { compilerOptions: {} },
      define: { __VITEHUB_PUBLIC_URL__: JSON.stringify({ agents: { first: "https://first.example.com", second: "https://second.example.com" } }) },
      plugins: [{ name: "published-lazy-registry", setup(builder) {
        builder.onResolve({ filter: /^#vitehub\/agent\/registry$/ }, () => ({ path: registry }))
        builder.onResolve({ filter: /^@vite-hub\/agent(?:\/|$)/ }, args => ({ path: join(packageRoot, manifest.exports[args.path === "@vite-hub/agent" ? "." : `.${args.path.slice("@vite-hub/agent".length)}`].import) }))
        builder.onResolve({ filter: /^@vite-hub\/runtime$/ }, () => ({ path: fileURLToPath(import.meta.resolve("@vite-hub/runtime")) }))
      } }],
    })
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", "const mod = await import(process.argv[1]); console.log(JSON.stringify(await mod.inspect()))", pathToFileURL(artifact).href])
    expect(JSON.parse(result.stdout)).toEqual([null, "https://first.example.com", "https://second.example.com"])
  } finally {
    await rm(artifact, { force: true })
    await rm(root, { force: true, recursive: true })
  }
}, 30_000)
