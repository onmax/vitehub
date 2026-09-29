import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { createServer } from "vite"
import { afterEach, describe, expect, it, vi } from "vitest"

import { runWorkflowCli } from "../src/cli.ts"
import { createWorkflowDevRuntimeModule, workflowDevRegistryId } from "../src/internal/dev-runtime.ts"
import { hubWorkflow } from "../src/vite.ts"

import type { ViteDevServer } from "vite"
import type { WorkflowCliContext } from "../src/cli.ts"
import type { WorkflowModuleOptions } from "../src/types.ts"

const tempRoot = resolve(import.meta.dirname, "../.vitest-tmp")
let root: string | undefined
let server: ViteDevServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (root) await rm(root, { force: true, recursive: true })
  root = undefined
})

async function startDevServer(workflow: WorkflowModuleOptions): Promise<{ context: () => WorkflowCliContext & { output: () => { stderr: string, stdout: string } }, root: string, url: string }> {
  await mkdir(tempRoot, { recursive: true })
  root = await mkdtemp(join(tempRoot, "dev-server-"))
  await mkdir(join(root, "server/workflows"), { recursive: true })
  await writeFile(join(root, "server/workflows/welcome.ts"), [
    "import { defineWorkflow } from '@vite-hub/workflow'",
    "",
    "export default defineWorkflow<{ name: string }>(async ({ payload }) => ({ greeting: `Hello ${payload.name}` }))",
    "",
  ].join("\n"))
  server = await createServer({
    configFile: false,
    logLevel: "silent",
    plugins: [hubWorkflow(workflow)],
    root,
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === "string") throw new Error("Vite Development Server has no port.")
  const url = `http://127.0.0.1:${address.port}`
  const projectRoot = root
  return {
    context: () => {
      const stdout: string[] = []
      const stderr: string[] = []
      return {
        cwd: projectRoot,
        env: { VITEHUB_DEV_SERVER_URL: url },
        output: () => ({ stderr: stderr.join(""), stdout: stdout.join("") }),
        rootDir: projectRoot,
        stderr: { write: chunk => stderr.push(String(chunk)) },
        stdout: { write: chunk => stdout.push(String(chunk)) },
      }
    },
    root: projectRoot,
    url,
  }
}

describe("Workflow dev runtime module", () => {
  it("installs the registry into the same Workflow runtime that it calls", () => {
    const code = createWorkflowDevRuntimeModule("vite-hub/_internal/workflow")
    expect(code).toContain(`import { setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "vite-hub/_internal/workflow/runtime/state"`)
    expect(code).toContain(`import registry from ${JSON.stringify(workflowDevRegistryId)}`)
    expect(code).toContain(`export { cancelWorkflow, getWorkflowRun, resumeWorkflowSignal, runWorkflow } from "vite-hub/_internal/workflow"`)
  })
})

describe("workflow CLI on a Vite Development Server", () => {
  it("starts a discovered Workflow inline and reads its result", { timeout: 30_000 }, async () => {
    const dev = await startDevServer({ provider: "vercel" })
    const start = dev.context()
    expect(await runWorkflowCli("start", ["welcome", "--input", "{\"name\":\"Ada\"}", "--json"], start)).toBe(0)
    const started = JSON.parse(start.output().stdout) as { run: { id: string, status: string, workflow: string } }
    expect(started.run).toMatchObject({ provider: "vercel", status: "queued", workflow: "welcome" })

    await vi.waitFor(async () => {
      const get = dev.context()
      expect(await runWorkflowCli("get", [started.run.id, "--json"], get)).toBe(0)
      expect(JSON.parse(get.output().stdout)).toEqual({
        run: { id: started.run.id, provider: "vercel", result: { greeting: "Hello Ada" }, status: "completed", workflow: "welcome" },
      })
    }, { timeout: 10_000 })

    const cancel = dev.context()
    expect(await runWorkflowCli("cancel", [started.run.id], cancel)).toBe(1)
    expect(cancel.output().stderr).toContain("workflow cancel is not supported by the local vercel dev runtime.")
  })

  it("refuses to reach a server for another project root", { timeout: 30_000 }, async () => {
    const dev = await startDevServer({ provider: "cloudflare" })
    const context = { ...dev.context(), rootDir: resolve(dev.root, "other") }
    expect(await runWorkflowCli("start", ["welcome"], context)).toBe(1)
    expect(context.output().stderr).toContain("Compatible Vite Development Server root mismatch")
  })
})
