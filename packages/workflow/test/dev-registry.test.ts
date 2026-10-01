import { existsSync } from "node:fs"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createWorkflowDevPluginModule, workflowDevGeneratedDir } from "../src/internal/dev-registry.ts"
import * as devRegistry from "../src/internal/dev-registry.ts"
import { hubWorkflow } from "../src/vite.ts"

import type { WorkflowModuleOptions } from "../src/types.ts"

let root: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  if (root) await rm(root, { force: true, recursive: true })
  root = undefined
})

function workflowModule(result: string): string {
  return [
    "import { defineWorkflow } from '@vite-hub/workflow'",
    "",
    `export default defineWorkflow(async () => ({ result: ${JSON.stringify(result)} }))`,
    "",
  ].join("\n")
}

async function createApp(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "vitehub-workflow-dev-registry-"))
  await writeFile(join(root, "package.json"), "{\"type\":\"module\"}\n")
  await mkdir(join(root, "server/workflows"), { recursive: true })
  await writeFile(join(root, "server/workflows/welcome.ts"), workflowModule("welcome"))
  return root
}

type ConfigHook = (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<unknown>

function configHook(options?: WorkflowModuleOptions): ConfigHook {
  const hook = hubWorkflow(options).config
  if (!hook || typeof hook === "function") throw new TypeError("Expected the hubWorkflow config hook to be an object hook.")
  expect(hook.order).toBe("pre")
  return hook.handler as unknown as ConfigHook
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Condition was not met in 30 seconds.")
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

describe("Workflow dev registry", () => {
  it("serializes overlapping refreshes and writes the latest discovery last", async () => {
    const projectRoot = await createApp()
    const plugin = hubWorkflow({ provider: "vercel" })
    const hook = plugin.config
    if (!hook || typeof hook === "function") throw new TypeError("Expected config object hook")
    await (hook.handler as unknown as ConfigHook)({ root: projectRoot }, { command: "serve", mode: "development" })
    let release = () => {}
    const barrier = new Promise<void>(resolve => { release = resolve })
    const originalWrite = devRegistry.writeWorkflowDevRegistryFiles
    const write = vi.spyOn(devRegistry, "writeWorkflowDevRegistryFiles")
      .mockImplementationOnce(async options => { await barrier; return originalWrite(options) })
    const watcher = new EventEmitter()
    const server = { watcher, environments: {}, config: { logger: { error: vi.fn() } } }
    if (typeof plugin.configureServer !== "function") throw new TypeError("Expected configureServer")
    await plugin.configureServer.call({} as never, server as never)
    const report = join(projectRoot, "server/workflows/report.ts")
    await writeFile(report, workflowModule("report"))
    watcher.emit("add", report)
    await waitFor(async () => write.mock.calls.length === 1)
    await rm(report)
    watcher.emit("unlink", report)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(write).toHaveBeenCalledTimes(1)
    release()
    await waitFor(async () => write.mock.calls.length === 2)
    const registry = join(projectRoot, workflowDevGeneratedDir, "dev-registry.mjs")
    await waitFor(async () => !(await readFile(registry, "utf8")).includes('"report"'))
    expect(server.config.logger.error).not.toHaveBeenCalled()
  })


  it("generates a Nitro plugin that installs the development registry", () => {
    const code = createWorkflowDevPluginModule("vite-hub/_internal/workflow")
    expect(code).toContain(`import { setWorkflowRuntimeRegistry } from "vite-hub/_internal/workflow/runtime/state"`)
    expect(code).toContain(`import registry from "./dev-registry.mjs"`)
    expect(code).toContain("setWorkflowRuntimeRegistry(registry)")
  })

  it("adds the registry plugin before Nitro reads its config in development", async () => {
    const projectRoot = await createApp()
    const nitro = { plugins: ["./server/plugins/app.ts"] }
    const config: Record<string, unknown> = { nitro, root: projectRoot }
    await configHook({ provider: "vercel" })(config, { command: "serve", mode: "development" })

    const directory = join(projectRoot, workflowDevGeneratedDir)
    expect(config.nitro).toMatchObject({ plugins: [join(directory, "dev-plugin.mjs"), "./server/plugins/app.ts"] })
    expect(nitro.plugins).toHaveLength(1)
    const registry = await readFile(join(directory, "dev-registry.mjs"), "utf8")
    expect(registry).toContain("\"welcome\"")
    expect(registry).toContain("server/workflows/welcome.ts")
  })

  it("does not add the registry plugin to build output or to disabled Workflows", async () => {
    const projectRoot = await createApp()
    const build: Record<string, unknown> = { root: projectRoot }
    await configHook({ provider: "vercel" })(build, { command: "build", mode: "production" })
    expect(build.nitro).toBeUndefined()

    const disabled: Record<string, unknown> = { root: projectRoot, workflow: false }
    await configHook()(disabled, { command: "serve", mode: "development" })
    expect((disabled.nitro as { plugins?: unknown[] } | undefined)?.plugins ?? []).toEqual([])
    expect(existsSync(join(projectRoot, workflowDevGeneratedDir, "dev-registry.mjs"))).toBe(false)
  })

  it("rewrites the registry and invalidates it in the Nitro dev runtime when a Workflow file is added", async () => {
    const projectRoot = await createApp()
    const plugin = hubWorkflow({ provider: "vercel" })
    const hook = plugin.config
    if (!hook || typeof hook === "function") throw new TypeError("Expected the hubWorkflow config hook to be an object hook.")
    await (hook.handler as unknown as ConfigHook)({ root: projectRoot }, { command: "serve", mode: "development" })

    const registryFile = join(projectRoot, workflowDevGeneratedDir, "dev-registry.mjs")
    const registryModule = { file: registryFile }
    const invalidated: unknown[] = []
    const errors: string[] = []
    const watcher = new EventEmitter()
    const server = {
      config: { logger: { error: (message: string) => errors.push(message) } },
      environments: {
        nitro: {
          moduleGraph: {
            getModulesByFile: (file: string) => file === registryFile ? new Set([registryModule]) : undefined,
            invalidateModule: (module: unknown) => invalidated.push(module),
          },
        },
      },
      watcher,
    }
    const configureServer = plugin.configureServer
    if (typeof configureServer !== "function") throw new TypeError("Expected the hubWorkflow configureServer hook.")
    // SAFETY: The hook reads only `config.logger`, `environments.nitro.moduleGraph`, and `watcher`.
    await configureServer.call({} as never, server as never)

    const report = join(projectRoot, "server/workflows/report.ts")
    await writeFile(report, workflowModule("report"))
    watcher.emit("add", report)
    await waitFor(async () => invalidated.length > 0)
    expect(await readFile(registryFile, "utf8")).toContain("\"report\"")
    expect(invalidated).toEqual([registryModule])

    // Changes outside Workflow files and to generated files do not rewrite the registry.
    watcher.emit("change", join(projectRoot, "server/routes/index.ts"))
    watcher.emit("change", registryFile)
    await rm(report)
    watcher.emit("unlink", report)
    await waitFor(async () => invalidated.length > 1)
    expect(await readFile(registryFile, "utf8")).not.toContain("\"report\"")
    expect(invalidated).toEqual([registryModule, registryModule])
    expect(errors).toEqual([])
  })
})
