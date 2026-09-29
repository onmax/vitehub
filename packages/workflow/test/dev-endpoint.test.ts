import { EventEmitter } from "node:events"
import { Readable } from "node:stream"

import { afterEach, describe, expect, it, vi } from "vitest"

import { registerWorkflowDevEndpoint, workflowDevRuntimeUnavailableCode, workflowDevRuntimeUnavailableMessage } from "../src/dev-endpoint.ts"
import { resolveWorkflowDevSupport, workflowDevHeader, workflowDevHeaderValue, workflowDevRoute, workflowDevRuntimeRoute } from "../src/dev-support.ts"
import { createWorkflowDevRequestHandler } from "../src/runtime/dev.ts"
import { getWorkflowRuntimeConfig, getWorkflowRuntimeRegistry, registerInlineWorkflowDefinition, resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { ViteHubNitroDevServer } from "@vite-hub/internal/dev-endpoint"
import type { WorkflowDevRuntimeOptions } from "../src/runtime/dev.ts"
import type { WorkflowDefinitionRegistry, WorkflowProvider } from "../src/types.ts"

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

const guard = { [workflowDevHeader]: workflowDevHeaderValue }
const jsonHeaders = { ...guard, "content-type": "application/json" }

function definitionModule(handler: (context: { payload: unknown }) => unknown): () => Promise<{ default: { handler: (context: { payload: unknown }) => unknown } }> {
  return async () => ({ default: { handler } })
}

const welcomeRegistry: WorkflowDefinitionRegistry = {
  welcome: definitionModule(({ payload }) => ({ greeting: "hello", payload })),
}

function handler(options: Partial<WorkflowDevRuntimeOptions> = {}) {
  const handle = createWorkflowDevRequestHandler({ configuredProvider: "vercel", registry: welcomeRegistry, ...options })
  return async (body: unknown, init: { headers?: Record<string, string>, method?: string, raw?: string } = {}) => {
    const response = await handle(new Request(`http://localhost:5173${workflowDevRuntimeRoute}`, {
      body: init.method === "GET" ? undefined : init.raw ?? JSON.stringify(body),
      headers: init.headers ?? jsonHeaders,
      method: init.method ?? "POST",
    }))
    const text = await response.text()
    let json: unknown
    try {
      json = JSON.parse(text)
    }
    catch {
      json = text
    }
    return { body: json, headers: response.headers, status: response.status }
  }
}

function runId(body: unknown): string {
  const id = (body as { run?: { id?: unknown } }).run?.id
  if (typeof id !== "string") throw new Error("Response has no run ID.")
  return id
}

afterEach(() => {
  resetWorkflowRuntime()
})

describe("Workflow dev support", () => {
  it("reports which operations each provider supports in the Nitro dev runtime", () => {
    const supported = (provider: WorkflowProvider | null) => Object.fromEntries(
      Object.entries(resolveWorkflowDevSupport(provider)).map(([operation, support]) => [operation, support.supported]),
    )
    expect(supported("vercel")).toEqual({ cancel: true, get: true, resume: true, start: true })
    expect(supported("cloudflare")).toEqual({ cancel: false, get: true, resume: false, start: true })
    expect(supported("openworkflow")).toEqual({ cancel: false, get: true, resume: false, start: true })
    expect(supported(null)).toEqual({ cancel: false, get: false, resume: false, start: false })
    expect(resolveWorkflowDevSupport(null, "Invalid Workflow config.").start.note).toBe("Invalid Workflow config.")
    expect(resolveWorkflowDevSupport("openworkflow").start.note).toContain("stays queued until an OpenWorkflow worker processes the same storage")
    expect(resolveWorkflowDevSupport("cloudflare").start.note).toContain("Uses the Cloudflare Workflow binding when the Nitro dev runtime has one.")
  })
})

describe("Workflow dev request handler", () => {
  it("starts and reads an inline run with the runtime state of the app", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    const call = handler()

    const started = await call({ input: { name: "Ada" }, operation: "start", workflow: "welcome" })
    expect(started.status).toBe(200)
    expect(started.headers.get("cache-control")).toBe("no-store")
    expect(started.body).toMatchObject({ note: expect.stringContaining("Runs the Workflow inline in the Nitro dev runtime"), run: { provider: "vercel", status: "queued", workflow: "welcome" } })
    expect(JSON.stringify(started.body)).not.toContain("Ada")
    const id = runId(started.body)

    await vi.waitFor(async () => {
      const read = await call({ operation: "get", runId: id })
      expect(read.status).toBe(200)
      expect((read.body as { run: unknown }).run).toEqual({ id, provider: "vercel", result: { greeting: "hello", payload: { name: "Ada" } }, status: "completed", workflow: "welcome" })
    })
  })

  it("does not change the Workflow configuration of the runtime", async () => {
    const call = handler({ configuredProvider: "cloudflare" })
    const started = await call({ operation: "start", workflow: "welcome" })
    expect(started.status).toBe(200)
    expect(started.body).toMatchObject({
      note: expect.stringContaining("The Vite config selects cloudflare, but the Nitro dev runtime uses vercel because the app installs no Workflow configuration in development."),
      run: { provider: "vercel" },
    })
    expect(getWorkflowRuntimeConfig()).toBeUndefined()
  })

  it("reports failed inline runs with a redacted error", async () => {
    setWorkflowRuntimeConfig({ provider: "cloudflare" })
    const call = handler({
      configuredProvider: "cloudflare",
      registry: {
        welcome: definitionModule(() => {
          throw new Error("Cannot connect to postgres://admin:hunter2@db.test/app")
        }),
      },
    })
    const id = runId((await call({ operation: "start", workflow: "welcome" })).body)

    await vi.waitFor(async () => {
      const read = await call({ operation: "get", runId: id })
      expect(read.body).toMatchObject({ run: { error: { message: "Cannot connect to postgres://[redacted]@db.test/app" }, status: "failed" } })
      expect(JSON.stringify(read.body)).not.toContain("hunter2")
    })
  })

  it("redacts credentials in run results", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    const call = handler({
      registry: { welcome: definitionModule(() => ({ apiKey: "sk-live", nested: { url: "https://user:pass@example.test" }, ok: true })) },
    })
    const id = runId((await call({ operation: "start", workflow: "welcome" })).body)

    await vi.waitFor(async () => {
      const read = await call({ operation: "get", runId: id })
      expect(read.body).toMatchObject({ run: { result: { apiKey: "[redacted]", nested: { url: "[redacted]" }, ok: true }, status: "completed" } })
      expect(JSON.stringify(read.body)).not.toMatch(/sk-live|user:pass/)
    })
  })

  it("rejects malformed requests, unknown Workflows, and unknown runs", async () => {
    const call = handler({ registry: { a: welcomeRegistry.welcome!, b: welcomeRegistry.welcome! } })
    expect(await call({ operation: "replay", runId: "x" })).toMatchObject({
      body: { error: { code: "WORKFLOW_DEV_INVALID_REQUEST", message: "Malformed Workflow Dev request." } },
      status: 400,
    })
    expect(await call(undefined, { raw: "{" })).toMatchObject({ body: { error: { code: "WORKFLOW_DEV_INVALID_REQUEST" } }, status: 400 })
    expect(await call({ operation: "start", workflow: "missing" })).toMatchObject({
      body: { error: { code: "WORKFLOW_DEFINITION_NOT_FOUND", message: "Unknown Workflow: missing. Available Workflows: a, b." } },
      status: 404,
    })
    expect(await call({ operation: "get", runId: "other" })).toMatchObject({
      body: { error: { code: "WORKFLOW_DEV_RUN_UNKNOWN", message: "Run other was not started by `vitehub workflow start` in this Nitro dev runtime. Pass --workflow <name>." } },
      status: 400,
    })
    expect(await call(undefined, { raw: JSON.stringify({ operation: "start", workflow: "a".repeat(1024 * 1024) }) })).toMatchObject({ status: 413 })
  })

  it("checks the guard header, origin, method, and content type", async () => {
    const call = handler()
    const body = { operation: "start", workflow: "welcome" }
    expect(await call(body, { headers: { "content-type": "application/json" } })).toEqual(expect.objectContaining({ body: "Forbidden Workflow Dev request.", status: 403 }))
    expect(await call(body, { headers: { ...jsonHeaders, origin: "http://evil.test" } })).toEqual(expect.objectContaining({ body: "Forbidden Workflow Dev origin.", status: 403 }))
    expect(await call(body, { headers: { ...guard, "content-type": "text/plain" } })).toEqual(expect.objectContaining({ body: "Workflow Dev requests must use application/json.", status: 415 }))
    expect((await call(undefined, { headers: guard, method: "GET" })).status).toBe(405)
    expect(getWorkflowRuntimeRegistry()).toBeUndefined()
  })

  it("rejects operations that the provider does not support", async () => {
    setWorkflowRuntimeConfig({ provider: "cloudflare" })
    const cloudflare = handler({ configuredProvider: "cloudflare" })
    expect(await cloudflare({ operation: "cancel", runId: "r", workflow: "welcome" })).toMatchObject({
      body: { error: { code: "WORKFLOW_DEV_UNSUPPORTED", message: "workflow cancel is not supported by the cloudflare provider. Cloudflare Workflows do not support cancellation through ViteHub." } },
      status: 501,
    })
    expect(await cloudflare({ operation: "resume", token: "t" })).toMatchObject({
      body: { error: { code: "WORKFLOW_DEV_UNSUPPORTED", message: "workflow resume is not supported by the cloudflare provider. Cloudflare Workflows do not support ViteHub signals." } },
      status: 501,
    })

    setWorkflowRuntimeConfig({ provider: "openworkflow" })
    expect(await handler({ configuredProvider: "openworkflow" })({ operation: "resume", token: "t" })).toMatchObject({
      body: { error: { code: "WORKFLOW_DEV_UNSUPPORTED", message: "workflow resume is not supported by the openworkflow provider. OpenWorkflow does not support ViteHub signals." } },
      status: 501,
    })
  })

  it("reports inline Vercel cancel as unsupported by the runtime", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    const call = handler()
    const id = runId((await call({ operation: "start", workflow: "welcome" })).body)
    const cancel = await call({ operation: "cancel", runId: id })
    expect(cancel.status).toBe(501)
    expect(cancel.body).toMatchObject({ error: { code: "WORKFLOW_OPERATION_UNSUPPORTED", message: "workflow cancel is not supported by the vercel provider for this run." } })
  })

  it("reports a disabled or invalid Workflow configuration", async () => {
    expect(await handler({ configError: "Unknown Workflow provider: nope.", configuredProvider: null })({ operation: "start", workflow: "welcome" })).toMatchObject({
      body: { error: { code: "WORKFLOW_DEV_UNSUPPORTED", message: "workflow start is not available. Unknown Workflow provider: nope." } },
      status: 409,
    })
    expect(await handler({ configuredProvider: null })({ operation: "get", runId: "r", workflow: "welcome" })).toMatchObject({
      body: { error: { code: "WORKFLOW_DEV_UNSUPPORTED", message: "workflow get is not available. Workflow is disabled in this app." } },
      status: 409,
    })
    setWorkflowRuntimeConfig(false)
    expect(await handler()({ operation: "start", workflow: "welcome" })).toMatchObject({
      body: { error: { code: "WORKFLOW_DISABLED", message: "Workflow is disabled in the Nitro dev runtime." } },
      status: 409,
    })
  })

  it("does not replace a Workflow registry that the app installed", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    const appRegistry: WorkflowDefinitionRegistry = { other: definitionModule(() => "other") }
    setWorkflowRuntimeRegistry(appRegistry)
    const call = handler()
    expect(await call({ operation: "start", workflow: "welcome" })).toMatchObject({
      body: { error: { code: "WORKFLOW_DEV_REGISTRY_CONFLICT", message: "The app installed its own Workflow registry, and it does not contain welcome." } },
      status: 409,
    })
    expect(getWorkflowRuntimeRegistry()).toBe(appRegistry)

    const shared = handler({ registry: { other: definitionModule(() => "dev copy") } })
    const id = runId((await shared({ operation: "start", workflow: "other" })).body)
    await vi.waitFor(async () => {
      expect(await shared({ operation: "get", runId: id })).toMatchObject({ body: { run: { result: "other", status: "completed" } } })
    })
  })

  it("replaces a registry that an earlier dev handler installed", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    await handler()({ operation: "get", runId: "r", workflow: "welcome" })
    const first = getWorkflowRuntimeRegistry()
    expect(first?.welcome).toBeTypeOf("function")

    await handler({ registry: { next: definitionModule(() => "next") } })({ operation: "get", runId: "r", workflow: "next" })
    expect(getWorkflowRuntimeRegistry()).not.toBe(first)
    expect(getWorkflowRuntimeRegistry()?.next).toBeTypeOf("function")
  })

  it("uses an inline definition of the app instead of the discovered module", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    registerInlineWorkflowDefinition("welcome", { handler: async () => "inline" })
    const call = handler()
    const id = runId((await call({ operation: "start", workflow: "welcome" })).body)
    await vi.waitFor(async () => {
      expect(await call({ operation: "get", runId: id })).toMatchObject({ body: { run: { result: "inline", status: "completed" } } })
    })
  })
})

describe("Workflow dev endpoint", () => {
  function fakeServer(environments?: Record<string, unknown>) {
    const middlewares: Middleware[] = []
    const server: ViteHubNitroDevServer = {
      config: { root: "/app", server: { port: 5173 } },
      environments,
      middlewares: { use: middleware => middlewares.push(middleware) },
    }
    return { middlewares, server }
  }

  async function call(middleware: Middleware, init: { body?: string, headers?: Record<string, string>, method: string }) {
    const done = new EventEmitter()
    const chunks: Buffer[] = []
    const res = {
      end: () => done.emit("end"),
      setHeader: () => undefined,
      statusCode: 200,
      write: (chunk: Buffer) => chunks.push(chunk),
    }
    const req = Object.assign(Readable.from(init.body ? [Buffer.from(init.body)] : []), {
      headers: { host: "localhost:5173", ...init.headers },
      method: init.method,
      url: workflowDevRoute,
    })
    const ended = new Promise(resolve => done.once("end", resolve))
    middleware(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => done.emit("end"))
    await ended
    return { body: Buffer.concat(chunks).toString("utf8"), status: res.statusCode }
  }

  it("reports hosts without an in-process Nitro environment", async () => {
    const { middlewares, server } = fakeServer()
    registerWorkflowDevEndpoint(server)
    expect(JSON.parse((await call(middlewares[0]!, { headers: guard, method: "GET" })).body)).toEqual({
      message: workflowDevRuntimeUnavailableMessage,
      root: "/app",
      runtime: "unavailable",
    })
    const post = await call(middlewares[0]!, { body: "{}", headers: jsonHeaders, method: "POST" })
    expect([post.status, JSON.parse(post.body)]).toEqual([501, { error: { code: workflowDevRuntimeUnavailableCode, message: workflowDevRuntimeUnavailableMessage } }])
  })

  it("forwards operations into the Nitro environment under the Nitro base URL", async () => {
    const dispatchFetch = vi.fn(async (request: Request) => Response.json({ body: await request.text(), url: request.url }))
    const { middlewares, server } = fakeServer({ nitro: { dispatchFetch } })
    registerWorkflowDevEndpoint(server, { nitroBaseURL: () => "/base/" })
    expect(JSON.parse((await call(middlewares[0]!, { headers: guard, method: "GET" })).body)).toEqual({ root: "/app", runtime: "nitro" })

    const body = JSON.stringify({ operation: "start", workflow: "welcome" })
    const post = await call(middlewares[0]!, { body, headers: jsonHeaders, method: "POST" })
    expect(JSON.parse(post.body)).toEqual({ body, url: `http://localhost/base${workflowDevRuntimeRoute}` })
    expect(dispatchFetch.mock.calls[0]?.[0].headers.get(workflowDevHeader)).toBe(workflowDevHeaderValue)
  })

  it("rejects requests without the guard header before it forwards them", async () => {
    const dispatchFetch = vi.fn(async () => Response.json({}))
    const { middlewares, server } = fakeServer({ nitro: { dispatchFetch } })
    registerWorkflowDevEndpoint(server)
    const missing = await call(middlewares[0]!, { body: "{}", headers: { "content-type": "application/json" }, method: "POST" })
    expect([missing.status, missing.body]).toEqual([403, "Forbidden Workflow Dev request."])
    const origin = await call(middlewares[0]!, { body: "{}", headers: { ...jsonHeaders, origin: "http://evil.test" }, method: "POST" })
    expect([origin.status, origin.body]).toEqual([403, "Forbidden Workflow Dev origin."])
    expect(dispatchFetch).not.toHaveBeenCalled()
  })
})
