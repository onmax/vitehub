import { existsSync } from "node:fs"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { createWorkflowDevPluginModule, workflowDevGeneratedDir } from "../src/internal/dev-registry.ts"
import { hubWorkflow } from "../src/vite.ts"

import type { ResolvedWorkflowOptions, WorkflowModuleOptions } from "../src/types.ts"

let root: string | undefined

afterEach(async () => {
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
  it("generates a Nitro plugin that installs the development registry", () => {
    const code = createWorkflowDevPluginModule({ provider: "vercel" }, "vite-hub/_internal/workflow")
    expect(code).toContain(`import { setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "vite-hub/_internal/workflow/runtime/state"`)
    expect(code).toContain(`import registry from "./dev-registry.mjs"`)
    expect(code).toContain("setWorkflowRuntimeRegistry(registry)")
  })

  it.each<ResolvedWorkflowOptions>([
    { provider: "vercel" },
    { provider: "cloudflare" },
    { provider: "openworkflow", sqlite: { path: ".data/workflow.sqlite" } },
    { provider: "openworkflow", postgres: { url: "postgres://localhost/workflow" } },
    { provider: "openworkflow", postgres: { url: { kind: "env-variable", source: { kind: "env", name: "OPENWORKFLOW_POSTGRES_URL" } } } },
  ])("installs the selected runtime configuration at startup: %j", async (workflow) => {
    const projectRoot = await createApp()
    await configHook(workflow)({ root: projectRoot }, { command: "serve", mode: "development" })

    // Execute the generated plugin with only its external Nitro and runtime state imports stubbed.
    const nitroDir = join(projectRoot, "node_modules/nitro")
    const stateDir = join(projectRoot, "node_modules/@vite-hub/workflow")
    await mkdir(nitroDir, { recursive: true })
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(nitroDir, "package.json"), JSON.stringify({ type: "module", exports: "./index.mjs" }))
    await writeFile(join(nitroDir, "index.mjs"), "export const definePlugin = setup => setup\n")
    await writeFile(join(stateDir, "package.json"), JSON.stringify({ type: "module", exports: { "./runtime/state": "./state.mjs" } }))
    await writeFile(join(stateDir, "state.mjs"), [
      "export let config, registry",
      "export const setWorkflowRuntimeConfig = value => { config = value }",
      "export const setWorkflowRuntimeRegistry = value => { registry = value }",
    ].join("\n"))
    const pluginUrl = pathToFileURL(join(projectRoot, workflowDevGeneratedDir, "dev-plugin.mjs")).href
    const stateUrl = pathToFileURL(join(stateDir, "state.mjs")).href
    const { default: startup } = await import(/* @vite-ignore */ pluginUrl)
    await startup()
    const state = await import(/* @vite-ignore */ stateUrl)
    expect(state.config).toEqual(workflow)
    expect(state.registry).toHaveProperty("welcome")
  })

  it("uses the config hook override when resolving runtime options", async () => {
    const projectRoot = await createApp()
    await configHook({ provider: "vercel" })({
      root: projectRoot,
      workflow: { provider: "openworkflow", sqlite: { path: ".data/override.sqlite" } },
    }, { command: "serve", mode: "development" })
    const plugin = await readFile(join(projectRoot, workflowDevGeneratedDir, "dev-plugin.mjs"), "utf8")
    expect(plugin).toContain('"provider":"openworkflow"')
    expect(plugin).toContain('"path":".data/override.sqlite"')
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

  it("discovers Workflows from the resolved project root for a nested Vite root", async () => {
    const projectRoot = await createApp()
    const appRoot = join(projectRoot, "app")
    await mkdir(appRoot)
    const config: Record<string, unknown> = { root: appRoot }
    await configHook({ provider: "vercel" })(config, { command: "serve", mode: "development" })

    const registry = await readFile(join(projectRoot, workflowDevGeneratedDir, "dev-registry.mjs"), "utf8")
    expect(registry).toContain("server/workflows/welcome.ts")
  })

  it("preserves explicit server directories with a nested Vite root", async () => {
    const projectRoot = await createApp()
    const appRoot = join(projectRoot, "app")
    const serverRoot = join(projectRoot, "custom-server")
    await mkdir(appRoot)
    await mkdir(join(serverRoot, "workflows"), { recursive: true })
    await writeFile(join(serverRoot, "workflows/custom.ts"), workflowModule("custom"))
    await configHook({ provider: "vercel" })({
      root: appRoot,
      __vitehubServerDirs: [serverRoot],
    }, { command: "serve", mode: "development" })

    const registry = await readFile(join(projectRoot, workflowDevGeneratedDir, "dev-registry.mjs"), "utf8")
    expect(registry).toContain("custom-server/workflows/custom.ts")
    expect(registry).not.toContain("server/workflows/welcome.ts")
  })

  it("does not add the registry plugin to build output or to disabled Workflows", async () => {
    const projectRoot = await createApp()
    const build: Record<string, unknown> = { root: projectRoot }
    await configHook({ provider: "vercel" })(build, { command: "build", mode: "production" })
    expect(build.nitro).toBeUndefined()

    const disabled: Record<string, unknown> = { root: projectRoot, workflow: false }
    await configHook()(disabled, { command: "serve", mode: "development" })
    expect(disabled.nitro).toBeUndefined()
    expect(existsSync(join(projectRoot, workflowDevGeneratedDir))).toBe(false)
  })

  it.each(["nitro", "ssr"])("refreshes the registry in the %s dev runtime on Workflow add, unlink, and change", async (environmentName) => {
    const projectRoot = await createApp()
    const plugin = hubWorkflow({ provider: "vercel" })
    const hook = plugin.config
    if (!hook || typeof hook === "function") throw new TypeError("Expected the hubWorkflow config hook to be an object hook.")
    await (hook.handler as unknown as ConfigHook)({ root: projectRoot }, { command: "serve", mode: "development" })

    const registryFile = join(projectRoot, workflowDevGeneratedDir, "dev-registry.mjs")
    const registryModule = { file: registryFile }
    const invalidated: unknown[] = []
    const reloads: unknown[] = []
    const errors: string[] = []
    const watcher = new EventEmitter()
    const server = {
      config: { logger: { error: (message: string) => errors.push(message) } },
      environments: {
        [environmentName]: {
          hot: { send: (message: unknown) => reloads.push(message) },
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
    // SAFETY: The hook reads only `config.logger`, the active server environment module graph and hot channel, and `watcher`.
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
    await writeFile(join(projectRoot, "server/workflows/welcome.ts"), workflowModule("updated"))
    watcher.emit("change", join(projectRoot, "server/workflows/welcome.ts"))
    await waitFor(async () => invalidated.length > 2)
    expect(invalidated).toEqual([registryModule, registryModule, registryModule])
    expect(reloads).toEqual([
      { type: "full-reload", triggeredBy: report },
      { type: "full-reload", triggeredBy: report },
      { type: "full-reload", triggeredBy: join(projectRoot, "server/workflows/welcome.ts") },
    ])
    expect(errors).toEqual([])
  })
})
