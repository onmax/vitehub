import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { createServer } from "vite"
import { afterEach, describe, expect, it, vi } from "vitest"

import { runWorkflowCli } from "../src/cli.ts"
import { workflowDevRuntimeUnavailableCode } from "../src/dev-endpoint.ts"
import { workflowDevRuntimeRoute } from "../src/dev-support.ts"
import { createWorkflowDevRuntimeModule, discoverWorkflowDevDefinitions, workflowDevGeneratedDir, writeWorkflowDevFiles } from "../src/internal/dev-runtime.ts"
import { hubWorkflow } from "../src/vite.ts"

import type { ViteDevServer } from "vite"
import type { WorkflowCliContext } from "../src/cli.ts"
import type { WorkflowModuleOptions } from "../src/types.ts"

let root: string | undefined
let server: ViteDevServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (root) await rm(root, { force: true, recursive: true })
  root = undefined
})

async function createApp(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "vitehub-workflow-dev-"))
  await writeFile(join(root, "package.json"), "{\"type\":\"module\"}\n")
  await mkdir(join(root, "server/workflows"), { recursive: true })
  await writeFile(join(root, "server/workflows/welcome.ts"), [
    "import { defineWorkflow } from '@vite-hub/workflow'",
    "",
    "export default defineWorkflow<{ name: string }>(async ({ payload }) => ({ greeting: `Hello ${payload.name}` }))",
    "",
  ].join("\n"))
  return root
}

type ConfigHook = (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<unknown>

function configHook(plugin: ReturnType<typeof hubWorkflow>): ConfigHook {
  const hook = plugin.config
  if (!hook || typeof hook === "function") throw new TypeError("Expected the hubWorkflow config hook to be an object hook.")
  expect(hook.order).toBe("pre")
  return hook.handler as unknown as ConfigHook
}

function cliContext(projectRoot: string, url: string) {
  const stdout: string[] = []
  const stderr: string[] = []
  const context: WorkflowCliContext = {
    cwd: projectRoot,
    env: { VITEHUB_DEV_SERVER_URL: url },
    rootDir: projectRoot,
    stderr: { write: chunk => stderr.push(String(chunk)) },
    stdout: { write: chunk => stdout.push(String(chunk)) },
  }
  return { context, stderr: () => stderr.join(""), stdout: () => stdout.join("") }
}

describe("Workflow dev runtime files", () => {
  it("generates a runtime module that passes the Vite config state and the registry to the dev handler", () => {
    const code = createWorkflowDevRuntimeModule({ configuredProvider: "cloudflare" }, "vite-hub/_internal/workflow")
    expect(code).toContain(`import { createWorkflowDevRequestHandler } from "vite-hub/_internal/workflow/runtime/dev"`)
    expect(code).toContain(`import registry from "./dev-registry.mjs"`)
    expect(code).toContain(`export const handleWorkflowDevRequest = createWorkflowDevRequestHandler({ ...{"configuredProvider":"cloudflare"}, registry })`)
    expect(createWorkflowDevRuntimeModule({ configError: "Bad config.", configuredProvider: null })).toContain(`{"configError":"Bad config.","configuredProvider":null}`)
  })

  it("writes the handler, runtime, and registry files, and skips files that did not change", async () => {
    const projectRoot = await createApp()
    const definitions = discoverWorkflowDevDefinitions(projectRoot)
    expect(definitions.map(definition => definition.name)).toEqual(["welcome"])

    const first = await writeWorkflowDevFiles({ configuredProvider: "vercel", definitions, projectRoot })
    const directory = join(projectRoot, workflowDevGeneratedDir)
    expect(first.handler).toBe(join(directory, "dev-handler.mjs"))
    expect(first.changed).toHaveLength(3)
    await expect(readFile(first.handler, "utf8")).resolves.toContain("import { handleWorkflowDevRequest as handleViteHubDevRequest } from \"./dev-runtime.mjs\"")
    const registry = await readFile(join(directory, "dev-registry.mjs"), "utf8")
    expect(registry).toContain("\"welcome\"")
    expect(registry).toContain("server/workflows/welcome.ts")

    expect((await writeWorkflowDevFiles({ configuredProvider: "vercel", definitions, projectRoot })).changed).toEqual([])
    expect((await writeWorkflowDevFiles({ configuredProvider: "openworkflow", definitions, projectRoot })).changed).toEqual([join(directory, "dev-runtime.mjs")])
  })
})

describe("Workflow Vite plugin in development", () => {
  it("adds the dev-only Nitro handler before Nitro reads its config", async () => {
    const projectRoot = await createApp()
    const nitro = { handlers: [{ handler: "./server/app.ts", route: "/app" }] }
    const config: Record<string, unknown> = { nitro, root: projectRoot }
    await configHook(hubWorkflow({ provider: "vercel" }))(config, { command: "serve", mode: "development" })
    expect(config.nitro).toMatchObject({
      handlers: [
        { handler: "./server/app.ts", route: "/app" },
        { handler: join(projectRoot, workflowDevGeneratedDir, "dev-handler.mjs"), route: workflowDevRuntimeRoute },
      ],
    })
    expect(nitro.handlers).toHaveLength(1)
  })

  it("does not add the dev handler to build output", async () => {
    const projectRoot = await createApp()
    const config: Record<string, unknown> = { root: projectRoot }
    await configHook(hubWorkflow({ provider: "vercel" }))(config, { command: "build", mode: "production" })
    expect(config.nitro).toBeUndefined()
    expect(existsSync(join(projectRoot, workflowDevGeneratedDir))).toBe(false)
  })

  it("rewrites the registry and invalidates it in the Nitro environment when a Workflow file changes", async () => {
    const projectRoot = await createApp()
    const plugin = hubWorkflow({ provider: "vercel" })
    await configHook(plugin)({ root: projectRoot }, { command: "serve", mode: "development" })
    const registryFile = join(projectRoot, workflowDevGeneratedDir, "dev-registry.mjs")
    const module = { file: registryFile }
    const getModulesByFile = vi.fn((file: string) => file === registryFile ? new Set([module]) : undefined)
    const invalidateModule = vi.fn()
    const hotUpdate = plugin.handleHotUpdate as (context: { file: string, server: unknown }) => Promise<void>

    const added = join(projectRoot, "server/workflows/report.ts")
    await writeFile(added, "export default { handler: async () => 'report' }\n")
    await hotUpdate({ file: added, server: { environments: { nitro: { moduleGraph: { getModulesByFile, invalidateModule } } } } })
    await expect(readFile(registryFile, "utf8")).resolves.toContain("\"report\"")
    expect(invalidateModule).toHaveBeenCalledWith(module)

    invalidateModule.mockClear()
    await hotUpdate({ file: join(projectRoot, "src/main.ts"), server: { environments: {} } })
    expect(invalidateModule).not.toHaveBeenCalled()
  })
})

describe("workflow CLI on a Vite Development Server", () => {
  async function startDevServer(workflow: WorkflowModuleOptions) {
    const projectRoot = await createApp()
    server = await createServer({
      configFile: false,
      logLevel: "silent",
      plugins: [hubWorkflow(workflow)],
      root: projectRoot,
      server: { host: "127.0.0.1", port: 0 },
    })
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === "string") throw new Error("Vite Development Server has no port.")
    return { root: projectRoot, url: `http://127.0.0.1:${address.port}` }
  }

  it("reports that plain Vite cannot reach the Workflow runtime", { timeout: 30_000 }, async () => {
    const dev = await startDevServer({ provider: "vercel" })
    const human = cliContext(dev.root, dev.url)
    expect(await runWorkflowCli("start", ["welcome"], human.context)).toBe(1)
    expect(human.stderr()).toContain("`vitehub workflow` commands need a Vite + Nitro host. Nuxt and plain Vite are not supported.")

    const json = cliContext(dev.root, dev.url)
    expect(await runWorkflowCli("get", ["run-1", "--json"], json.context)).toBe(1)
    expect(JSON.parse(json.stdout())).toMatchObject({ error: { code: workflowDevRuntimeUnavailableCode } })

    const response = await fetch(`${dev.url}/__vitehub/workflow/dev`, {
      body: JSON.stringify({ operation: "start", workflow: "welcome" }),
      headers: { "content-type": "application/json", "x-vitehub-workflow-dev": "1" },
      method: "POST",
    })
    expect([response.status, await response.json()]).toEqual([501, { error: { code: workflowDevRuntimeUnavailableCode, message: expect.stringContaining("Nuxt and plain Vite are not supported.") } }])
  })

  it("refuses to reach a server for another project root", { timeout: 30_000 }, async () => {
    const dev = await startDevServer({ provider: "cloudflare" })
    const output = cliContext(resolve(dev.root, "other"), dev.url)
    expect(await runWorkflowCli("start", ["welcome"], output.context)).toBe(1)
    expect(output.stderr()).toContain("Compatible Vite Development Server root mismatch")
  })
})
