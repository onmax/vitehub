import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { hubWorkflow } from "../src/vite.ts"
import type { ResolvedConfig } from "vite"

describe("Workflow preparation for Schedule", () => {
  it("retains each reused build's Workflow sources and aliases", async () => {
    const plugin = hubWorkflow({ provider: "vercel" })
    const roots: string[] = []
    try {
      const configs: ResolvedConfig[] = []
      for (const name of ["first", "second"]) {
        const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-schedule-build-"))
        roots.push(root)
        const server = join(root, "backend")
        await mkdir(join(server, "workflows"), { recursive: true })
        await symlink(join(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
        await writeFile(join(root, "alias.ts"), `export const name = ${JSON.stringify(name)}\n`)
        await writeFile(join(server, "workflows", `${name}.ts`), "export default async function run() { return 'ok' }\n")
        const config = {
          root,
          command: "build",
          plugins: [],
          workflow: { provider: "vercel" },
          resolve: { alias: [{ find: "build-alias", replacement: join(root, "alias.ts") }] },
          [VITEHUB_SERVER_DIRS]: [server],
        } as unknown as ResolvedConfig
        configs.push(config)
        await (plugin.configResolved as (config: ResolvedConfig) => void)(config)
      }
      const artifacts = await Promise.all(configs.map(config =>
        plugin.vitehub?.workflow?.prepareScheduleRuntime?.(join(config.root, "artifact"), config),
      ))
      for (const [index, runtime] of artifacts.entries()) {
        expect(runtime).toBeDefined()
        const name = index === 0 ? "first" : "second"
        const other = index === 0 ? "second" : "first"
        const registry = await readFile(runtime!.registryFile, "utf8")
        expect(registry).toContain(`${name}.ts`)
        expect(registry).not.toContain(`${other}.ts`)
        expect(await readFile(runtime!.bundleAlias["build-alias"]!, "utf8")).toContain(JSON.stringify(name))
      }
    } finally {
      await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
    }
  })
})
