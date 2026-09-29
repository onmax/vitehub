import { createServer } from "node:http"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createWorkflowDevHandler, registerWorkflowDevEndpoint } from "../src/dev-endpoint.ts"
import { resolveWorkflowDevSupport, workflowDevHeader, workflowDevRoute } from "../src/dev-support.ts"
import { cancelWorkflow, getWorkflowRun, resumeWorkflowSignal, runWorkflow } from "../src/runtime/client.ts"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { ViteHubDevEndpointServer } from "@vite-hub/internal/dev-endpoint"
import type { WorkflowDevRuntime, WorkflowDevState } from "../src/dev-endpoint.ts"
import type { WorkflowProvider } from "../src/types.ts"

const realRuntime: WorkflowDevRuntime = { cancelWorkflow, getWorkflowRun, resumeWorkflowSignal, runWorkflow }

function state(provider: WorkflowProvider | null, overrides: Partial<WorkflowDevState> = {}): () => WorkflowDevState {
  return () => ({ provider, root: "/app", workflows: ["welcome"], ...overrides })
}

function fakeRuntime(overrides: Partial<WorkflowDevRuntime> = {}): WorkflowDevRuntime {
  const unexpected = async () => {
    throw new Error("unexpected runtime call")
  }
  return { cancelWorkflow: unexpected, getWorkflowRun: unexpected, resumeWorkflowSignal: unexpected, runWorkflow: unexpected, ...overrides }
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

afterEach(() => {
  resetWorkflowRuntime()
})

describe("local Workflow dev support", () => {
  it("reports which operations each provider supports on the Vite Development Server", () => {
    const supported = (provider: WorkflowProvider | null) => Object.fromEntries(
      Object.entries(resolveWorkflowDevSupport(provider)).map(([operation, support]) => [operation, support.supported]),
    )
    expect(supported("vercel")).toEqual({ cancel: false, get: true, resume: false, start: true })
    expect(supported("cloudflare")).toEqual({ cancel: false, get: true, resume: false, start: true })
    expect(supported("openworkflow")).toEqual({ cancel: false, get: true, resume: false, start: true })
    expect(supported(null)).toEqual({ cancel: false, get: false, resume: false, start: false })
    expect(resolveWorkflowDevSupport(null, "Invalid Workflow config.").start.note).toBe("Invalid Workflow config.")
    expect(resolveWorkflowDevSupport("openworkflow").start.note).toContain("does not start an OpenWorkflow worker")
    expect(resolveWorkflowDevSupport("cloudflare").start.note).toContain("Cloudflare Workflow bindings exist only in the Workers runtime")
  })

  it("returns discovery data with the support matrix", () => {
    const handler = createWorkflowDevHandler({ loadRuntime: async () => fakeRuntime(), state: state("vercel") })
    expect(handler.discover()).toEqual({
      operations: resolveWorkflowDevSupport("vercel"),
      provider: "vercel",
      root: "/app",
      workflows: ["welcome"],
    })
  })
})

describe("Workflow dev handler", () => {
  it("starts and reads an inline run through the Workflow runtime client", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async ({ payload }: { payload: unknown }) => ({ greeting: "hello", payload }) } }),
    })
    const handler = createWorkflowDevHandler({ loadRuntime: async () => realRuntime, state: state("vercel") })

    const started = await handler.execute({ input: { name: "Ada" }, operation: "start", workflow: "welcome" })
    expect(started.status).toBe(200)
    expect(started.body).toMatchObject({ run: { provider: "vercel", status: "queued", workflow: "welcome" } })
    expect(JSON.stringify(started.body)).not.toContain("Ada")
    const runId = "run" in started.body ? started.body.run.id : ""

    await vi.waitFor(async () => {
      const read = await handler.execute({ operation: "get", runId })
      expect(read).toEqual({
        body: { run: { id: runId, provider: "vercel", result: { greeting: "hello", payload: { name: "Ada" } }, status: "completed", workflow: "welcome" } },
        status: 200,
      })
    })
  })

  it("reports failed inline runs with a redacted error", async () => {
    setWorkflowRuntimeConfig({ provider: "cloudflare" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => {
        throw new Error("Cannot connect to postgres://admin:hunter2@db.test/app")
      } } }),
    })
    const handler = createWorkflowDevHandler({ loadRuntime: async () => realRuntime, state: state("cloudflare") })
    const started = await handler.execute({ operation: "start", workflow: "welcome" })
    const runId = "run" in started.body ? started.body.run.id : ""

    await vi.waitFor(async () => {
      const read = await handler.execute({ operation: "get", runId })
      expect(read.body).toMatchObject({ run: { error: { message: "Cannot connect to postgres://[redacted]@db.test/app" }, status: "failed" } })
    })
  })

  it("redacts credentials in run results and metadata", async () => {
    const handler = createWorkflowDevHandler({
      loadRuntime: async () => fakeRuntime({
        getWorkflowRun: async (_name, id) => ({
          id,
          metadata: { dsn: "postgres://a:b@host/db", mode: "inline" },
          provider: "openworkflow",
          result: { apiKey: "sk-live", nested: { url: "https://user:pass@example.test" }, ok: true },
          status: "completed",
        }),
      }),
      state: state("openworkflow"),
    })
    const read = await handler.execute({ operation: "get", runId: "ow-1", workflow: "welcome" })
    expect(read.body).toEqual({
      run: {
        id: "ow-1",
        metadata: { dsn: "[redacted]", mode: "inline" },
        provider: "openworkflow",
        result: { apiKey: "[redacted]", nested: { url: "[redacted]" }, ok: true },
        status: "completed",
        workflow: "welcome",
      },
    })
    expect(JSON.stringify(read.body)).not.toMatch(/sk-live|pass@|a:b@/)
  })

  it("rejects malformed requests and unknown Workflows", async () => {
    const handler = createWorkflowDevHandler({ loadRuntime: async () => fakeRuntime(), state: state("vercel", { workflows: ["a", "b"] }) })
    expect(await handler.execute({ operation: "replay", runId: "x" })).toEqual({
      body: { error: { code: "WORKFLOW_DEV_INVALID_REQUEST", message: "Malformed Workflow Dev request." } },
      status: 400,
    })
    expect(await handler.execute({ operation: "start", workflow: "missing" })).toEqual({
      body: { error: { code: "WORKFLOW_DEFINITION_NOT_FOUND", message: "Unknown Workflow: missing. Available Workflows: a, b." } },
      status: 404,
    })
    expect(await handler.execute({ operation: "get", runId: "other" })).toEqual({
      body: { error: { code: "WORKFLOW_DEV_RUN_UNKNOWN", message: "Run other was not started through this Vite Development Server. Pass --workflow <name>." } },
      status: 400,
    })
  })

  it("rejects operations that the local provider runtime does not support before it loads the runtime", async () => {
    const loadRuntime = vi.fn(async () => fakeRuntime())
    const vercel = createWorkflowDevHandler({ loadRuntime, state: state("vercel") })
    const cancel = await vercel.execute({ operation: "cancel", runId: "run-1", workflow: "welcome" })
    expect(cancel.status).toBe(501)
    expect(cancel.body).toEqual({ error: { code: "WORKFLOW_DEV_UNSUPPORTED", message: expect.stringMatching(/^workflow cancel is not supported by the local vercel dev runtime\. Inline Vercel runs cannot be cancelled\./) } })

    const cloudflare = createWorkflowDevHandler({ loadRuntime, state: state("cloudflare") })
    expect((await cloudflare.execute({ operation: "resume", token: "t" })).body).toEqual({
      error: { code: "WORKFLOW_DEV_UNSUPPORTED", message: "workflow resume is not supported by the local cloudflare dev runtime. Cloudflare Workflows do not support ViteHub signals." },
    })

    const disabled = createWorkflowDevHandler({ loadRuntime, state: state(null, { error: "Unknown Workflow provider: nope." }) })
    expect(await disabled.execute({ operation: "start", workflow: "welcome" })).toEqual({
      body: { error: { code: "WORKFLOW_DEV_UNSUPPORTED", message: "workflow start is not available. Unknown Workflow provider: nope." } },
      status: 409,
    })
    expect(loadRuntime).not.toHaveBeenCalled()
  })

  it("maps runtime error codes to honest messages", async () => {
    const handler = (runtime: Partial<WorkflowDevRuntime>) => createWorkflowDevHandler({ loadRuntime: async () => fakeRuntime(runtime), state: state("vercel") })
    expect(await handler({ runWorkflow: async () => { throw codedError("WORKFLOW_OPERATION_UNSUPPORTED", "no") } }).execute({ operation: "start", workflow: "welcome" })).toEqual({
      body: { error: { code: "WORKFLOW_OPERATION_UNSUPPORTED", message: "workflow start is not supported by the vercel provider." } },
      status: 501,
    })
    expect(await handler({ getWorkflowRun: async () => { throw codedError("VERCEL_WORKFLOW_SDK_LOAD_FAILED", "missing sdk") } }).execute({ operation: "get", runId: "r", workflow: "welcome" })).toEqual({
      body: { error: { code: "VERCEL_WORKFLOW_SDK_LOAD_FAILED", message: "workflow get needs a native Vercel Workflow run, which the local dev runtime does not start." } },
      status: 501,
    })
    expect(await handler({ runWorkflow: async () => { throw new Error("boom at https://u:p@host.test") } }).execute({ operation: "start", workflow: "welcome" })).toEqual({
      body: { error: { code: "WORKFLOW_DEV_FAILED", message: "boom at https://[redacted]@host.test" } },
      status: 500,
    })
  })
})

describe("Workflow dev endpoint guard", () => {
  let http: Server | undefined

  afterEach(async () => {
    await new Promise<void>(resolve => http ? http.close(() => resolve()) : resolve())
    http = undefined
  })

  async function listen(): Promise<{ loadRuntime: ReturnType<typeof vi.fn>, url: string }> {
    const handlers: Array<(req: IncomingMessage, res: ServerResponse, next: () => void) => void> = []
    const server: ViteHubDevEndpointServer = {
      config: { server: {} },
      middlewares: { use: handler => handlers.push(handler) },
      resolvedUrls: null,
    }
    const loadRuntime = vi.fn(async () => fakeRuntime({
      runWorkflow: async name => ({ id: `run-${name}`, provider: "vercel", status: "queued" }),
    }))
    registerWorkflowDevEndpoint(server, createWorkflowDevHandler({ loadRuntime, state: state("vercel") }))
    http = createServer((req, res) => {
      handlers[0]!(req, res, () => {
        res.statusCode = 404
        res.end("next")
      })
    })
    await new Promise<void>(resolve => http!.listen(0, "127.0.0.1", () => resolve()))
    const address = http.address()
    if (!address || typeof address === "string") throw new Error("Test server has no port.")
    return { loadRuntime, url: `http://127.0.0.1:${address.port}${workflowDevRoute}` }
  }

  it("rejects requests without the guard header, from another origin, or without JSON", async () => {
    const { loadRuntime, url } = await listen()
    const body = JSON.stringify({ operation: "start", workflow: "welcome" })
    const missing = await fetch(url, { body, headers: { "content-type": "application/json" }, method: "POST" })
    expect([missing.status, await missing.text()]).toEqual([403, "Forbidden Workflow Dev request."])
    const origin = await fetch(url, { body, headers: { "content-type": "application/json", [workflowDevHeader]: "1", origin: "http://evil.test" }, method: "POST" })
    expect([origin.status, await origin.text()]).toEqual([403, "Forbidden Workflow Dev origin."])
    const text = await fetch(url, { body, headers: { "content-type": "text/plain", [workflowDevHeader]: "1" }, method: "POST" })
    expect([text.status, await text.text()]).toEqual([415, "Workflow Dev requests must use application/json."])
    const method = await fetch(url, { headers: { [workflowDevHeader]: "1" }, method: "DELETE" })
    expect(method.status).toBe(405)
    expect(loadRuntime).not.toHaveBeenCalled()
  })

  it("serves discovery and runs guarded requests", async () => {
    const { url } = await listen()
    const discovery = await fetch(url, { headers: { [workflowDevHeader]: "1" } })
    expect(await discovery.json()).toMatchObject({ provider: "vercel", root: "/app", workflows: ["welcome"] })

    const started = await fetch(url, { body: JSON.stringify({ operation: "start", workflow: "welcome" }), headers: { "content-type": "application/json", [workflowDevHeader]: "1" }, method: "POST" })
    expect([started.status, await started.json()]).toEqual([200, { run: { id: "run-welcome", provider: "vercel", status: "queued", workflow: "welcome" } }])

    const malformed = await fetch(url, { body: "{", headers: { "content-type": "application/json", [workflowDevHeader]: "1" }, method: "POST" })
    expect([malformed.status, await malformed.json()]).toEqual([400, { error: { code: "WORKFLOW_DEV_INVALID_REQUEST", message: "Malformed Workflow Dev request." } }])
  })
})
