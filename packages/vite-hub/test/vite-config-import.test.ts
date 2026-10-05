import { execFile } from "node:child_process"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const execFileAsync = promisify(execFile)

// These packages serve requests, Invocations, or definition analysis. An empty project's Vite config must not load them.
const requestTimePackages = ["typescript", "better-auth", "drizzle-orm", "@libsql/client", "effect", "unimport"]

// The probe records every module that Node loads while the config imports `vite-hub` and resolves its Vite plugins.
const probe = `
import { registerHooks } from "node:module"

const loaded = []
registerHooks({
  load(url, context, next) {
    loaded.push(url)
    return next(url, context)
  },
})
const { resolveConfig } = await import(process.argv[3])
const { vitehub } = await import(process.argv[2])
await resolveConfig({
  configFile: false,
  logLevel: "silent",
  root: process.cwd(),
  plugins: [vitehub({
    preset: "node",
    agent: true,
    auth: true,
    blob: true,
    console: true,
    database: true,
    kv: true,
    queue: true,
    sandbox: true,
    schedule: true,
    workflow: true,
    workspace: true,
  })],
}, "serve")
process.stdout.write(JSON.stringify(loaded))
`

function packageName(url: string): string | undefined {
  const index = url.lastIndexOf("/node_modules/")
  if (index < 0) return undefined
  const [scope, name] = url.slice(index + "/node_modules/".length).split("/")
  return scope?.startsWith("@") ? `${scope}/${name}` : scope
}

describe("vite-hub config import", () => {
  it("keeps request-time dependencies unloaded through config resolution with Console enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-config-import-"))
    try {
      const probeFile = join(root, "probe.mjs")
      await writeFile(probeFile, probe)
      await writeFile(join(root, "package.json"), '{"type":"module"}\n')
      const entry = pathToFileURL(join(packageRoot, "dist/index.js")).href
      const viteEntry = import.meta.resolve("vite")
      const { stdout } = await execFileAsync(process.execPath, [probeFile, entry, viteEntry], {
        cwd: root,
        env: { ...process.env, VITEHUB_CONSOLE_FIXTURE: "" },
        timeout: 60_000,
      })
      const loaded: unknown = JSON.parse(stdout)
      if (!Array.isArray(loaded)) throw new TypeError("Expected the probe to print loaded module URLs.")
      const urls = loaded.filter((url): url is string => typeof url === "string")

      expect(urls).toContain(entry)
      const packages = new Set(urls.map(packageName))
      expect(requestTimePackages.filter(name => packages.has(name))).toEqual([])
      await access(join(root, ".vitehub/nitro/console/plugin.mjs"))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 90_000)
})
