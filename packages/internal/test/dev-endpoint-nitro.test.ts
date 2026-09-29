import { EventEmitter } from "node:events"
import { readFile } from "node:fs/promises"
import { Readable } from "node:stream"
import { describe, expect, it, vi } from "vitest"

import {
  findViteHubNitroDevEnvironment,
  forwardViteHubDevRequestToNitro,
  isViteHubNitroDevHostAllowed,
  registerViteHubNitroDevEndpoint,
  renderViteHubNitroDevHandler,
  validateViteHubNitroDevRequest,
  viteHubNitroDevUnavailableCode,
  viteHubNitroDevUnavailableMessage,
  viteHubNitroRuntimeRoute,
} from "../src/dev-endpoint.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { ViteHubNitroDevServer } from "../src/dev-endpoint.ts"

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

const root = "/project"
const route = "/__test/dev"
const runtimeRoute = "/_vitehub/test/dev"
const guard = { header: "x-test-dev", headerValue: "1", label: "Test Dev" }
const guardHeaders = { [guard.header]: guard.headerValue }
const json = { ...guardHeaders, "content-type": "application/json" }

function fakeServer(environments?: Record<string, unknown>) {
  const middlewares: Middleware[] = []
  const server: ViteHubNitroDevServer = {
    config: { root, server: { port: 5173 } },
    environments,
    middlewares: { use: handler => middlewares.push(handler) },
  }
  return { middlewares, server }
}

function incoming(init: { body?: string, headers?: Record<string, string>, method: string }): IncomingMessage {
  return Object.assign(Readable.from(init.body ? [Buffer.from(init.body)] : []), {
    headers: { host: "localhost:5173", ...init.headers },
    method: init.method,
    url: route,
  }) as unknown as IncomingMessage
}

async function call(middleware: Middleware, init: { body?: string, headers?: Record<string, string>, method: string }) {
  const done = new EventEmitter()
  const chunks: Buffer[] = []
  const headers: Record<string, string> = {}
  const res = {
    end() {
      done.emit("end")
    },
    setHeader(name: string, value: string) {
      headers[name] = value
    },
    statusCode: 200,
    write(chunk: Buffer) {
      chunks.push(chunk)
    },
  }
  const ended = new Promise(resolve => done.once("end", resolve))
  middleware(incoming(init), res as unknown as ServerResponse, () => done.emit("end"))
  await ended
  return { body: Buffer.concat(chunks).toString("utf8"), headers, status: res.statusCode }
}

function nitroRequest(init: { headers?: Record<string, string>, method?: string } = {}): Request {
  return new Request(`http://localhost:5173${runtimeRoute}`, {
    body: init.method === "GET" ? undefined : "{}",
    headers: init.headers ?? json,
    method: init.method ?? "POST",
  })
}

describe("Nitro dev forwarding", () => {
  it("finds only a Nitro environment that can dispatch requests", () => {
    const nitro = { dispatchFetch: async () => new Response() }
    expect(findViteHubNitroDevEnvironment({ environments: { nitro } })).toBe(nitro)
    expect(findViteHubNitroDevEnvironment({ environments: { nitro: {} } })).toBeUndefined()
    expect(findViteHubNitroDevEnvironment({ environments: { ssr: nitro } })).toBeUndefined()
    expect(findViteHubNitroDevEnvironment({})).toBeUndefined()
  })

  it("prefixes the runtime route with the Nitro base URL", () => {
    expect(viteHubNitroRuntimeRoute(runtimeRoute)).toBe(runtimeRoute)
    expect(viteHubNitroRuntimeRoute(runtimeRoute, "/")).toBe(runtimeRoute)
    expect(viteHubNitroRuntimeRoute(runtimeRoute, "/app/")).toBe(`/app${runtimeRoute}`)
    expect(viteHubNitroRuntimeRoute(runtimeRoute, "app")).toBe(`/app${runtimeRoute}`)
  })

  it("returns 501 with a clear message when the Vite process has no Nitro environment", async () => {
    const response = await forwardViteHubDevRequestToNitro({}, incoming({ body: "{}", method: "POST" }), { ...guard, runtimeRoute })
    expect(response.status).toBe(501)
    expect(await response.json()).toEqual({
      error: { code: viteHubNitroDevUnavailableCode, message: viteHubNitroDevUnavailableMessage("Test Dev") },
    })
    expect(viteHubNitroDevUnavailableMessage("Test Dev")).toContain("Nuxt and plain Vite are not supported")

    const custom = await forwardViteHubDevRequestToNitro({}, incoming({ body: "{}", method: "POST" }), {
      ...guard,
      runtimeRoute,
      unavailable: { code: "TEST_UNAVAILABLE", message: "No test runtime." },
    })
    expect(await custom.json()).toEqual({ error: { code: "TEST_UNAVAILABLE", message: "No test runtime." } })
  })

  it("forwards the body with the guard header under the Nitro base URL", async () => {
    const dispatchFetch = vi.fn(async (request: Request) => Response.json({ body: await request.text(), url: request.url }))
    const response = await forwardViteHubDevRequestToNitro(
      { environments: { nitro: { dispatchFetch } } },
      incoming({ body: "{\"operation\":\"list\"}", method: "POST" }),
      { ...guard, nitroBaseURL: () => "/app/", runtimeRoute },
    )

    expect(await response.json()).toEqual({ body: "{\"operation\":\"list\"}", url: `http://localhost/app${runtimeRoute}` })
    const forwarded = dispatchFetch.mock.calls[0]![0]
    expect(forwarded.method).toBe("POST")
    expect(forwarded.headers.get(guard.header)).toBe(guard.headerValue)
    expect(forwarded.headers.get("content-type")).toBe("application/json")
  })
})

describe("Nitro dev endpoint", () => {
  it("checks the Vite guard before it forwards", async () => {
    const dispatchFetch = vi.fn(async () => new Response())
    const { middlewares, server } = fakeServer({ nitro: { dispatchFetch } })
    registerViteHubNitroDevEndpoint(server, { ...guard, route, runtimeRoute })

    expect(await call(middlewares[0]!, { method: "GET" })).toMatchObject({ body: "Forbidden Test Dev request.", status: 403 })
    expect(await call(middlewares[0]!, { headers: { ...guardHeaders, origin: "https://attacker.test" }, method: "GET" })).toMatchObject({ status: 403 })
    expect(await call(middlewares[0]!, { body: "{}", headers: { ...guardHeaders, "content-type": "text/plain" }, method: "POST" })).toMatchObject({ status: 415 })
    expect(await call(middlewares[0]!, { headers: guardHeaders, method: "DELETE" })).toMatchObject({ status: 405 })
    expect(dispatchFetch).not.toHaveBeenCalled()
  })

  it("reports the runtime on discovery and returns 501 without Nitro", async () => {
    const { middlewares, server } = fakeServer()
    registerViteHubNitroDevEndpoint(server, { ...guard, route, runtimeRoute })

    const discovery = await call(middlewares[0]!, { headers: guardHeaders, method: "GET" })
    expect(discovery.headers["cache-control"]).toBe("no-store")
    expect(JSON.parse(discovery.body)).toEqual({ message: viteHubNitroDevUnavailableMessage("Test Dev"), root, runtime: "unavailable" })
    const operation = await call(middlewares[0]!, { body: "{}", headers: json, method: "POST" })
    expect(operation.status).toBe(501)
    expect(JSON.parse(operation.body)).toMatchObject({ error: { code: viteHubNitroDevUnavailableCode } })
  })

  it("forwards operations and does not cache the response", async () => {
    const dispatchFetch = vi.fn(async (request: Request) => Response.json({ url: request.url }, { headers: { "x-runtime": "nitro" } }))
    const { middlewares, server } = fakeServer({ nitro: { dispatchFetch } })
    registerViteHubNitroDevEndpoint(server, { ...guard, nitroBaseURL: () => "/app/", route, runtimeRoute })

    expect(JSON.parse((await call(middlewares[0]!, { headers: guardHeaders, method: "GET" })).body)).toEqual({ root, runtime: "nitro" })
    const operation = await call(middlewares[0]!, { body: "{}", headers: json, method: "POST" })
    expect(operation).toMatchObject({ headers: { "cache-control": "no-store", "x-runtime": "nitro" }, status: 200 })
    expect(JSON.parse(operation.body)).toEqual({ url: `http://localhost/app${runtimeRoute}` })
  })

  it("redacts credentials when forwarding fails", async () => {
    const dispatchFetch = vi.fn(async () => {
      throw new Error("Nitro failed with token=sk_live_secret123456")
    })
    const { middlewares, server } = fakeServer({ nitro: { dispatchFetch } })
    registerViteHubNitroDevEndpoint(server, { ...guard, route, runtimeRoute })

    const operation = await call(middlewares[0]!, { body: "{}", headers: json, method: "POST" })
    expect(operation.status).toBe(500)
    expect(operation.body).toContain("Test Dev request failed")
    expect(operation.body).not.toContain("sk_live_secret123456")
  })
})

describe("Nitro dev handler", () => {
  it("accepts a guarded JSON POST", () => {
    expect(validateViteHubNitroDevRequest(nitroRequest(), guard)).toBeUndefined()
    expect(validateViteHubNitroDevRequest(nitroRequest({ headers: { ...json, origin: "http://localhost:5173" } }), guard)).toBeUndefined()
  })

  it("rejects requests that do not pass the guard", async () => {
    const missingHeader = validateViteHubNitroDevRequest(nitroRequest({ headers: { "content-type": "application/json" } }), guard)
    expect(missingHeader?.status).toBe(403)
    expect(await missingHeader?.text()).toBe("Forbidden Test Dev request.")
    expect(validateViteHubNitroDevRequest(nitroRequest({ headers: { ...json, origin: "https://attacker.test" } }), guard)?.status).toBe(403)
    const get = validateViteHubNitroDevRequest(nitroRequest({ headers: guardHeaders, method: "GET" }), guard)
    expect(get?.status).toBe(405)
    expect(get?.headers.get("allow")).toBe("POST")
    expect(validateViteHubNitroDevRequest(nitroRequest({ headers: { ...guardHeaders, "content-type": "text/plain" } }), guard)?.status).toBe(415)
  })

  it("accepts only the loopback host names that the forwarder uses", async () => {
    const at = (url: string, headers: Record<string, string> = json) => new Request(url, { body: "{}", headers, method: "POST" })

    expect(isViteHubNitroDevHostAllowed(at(`http://localhost${runtimeRoute}`))).toBe(true)
    expect(isViteHubNitroDevHostAllowed(at(`http://app.localhost:3000${runtimeRoute}`))).toBe(true)
    expect(isViteHubNitroDevHostAllowed(at(`http://127.0.0.1:3000${runtimeRoute}`))).toBe(true)
    expect(isViteHubNitroDevHostAllowed(at(`http://[::1]:3000${runtimeRoute}`))).toBe(true)

    const rebound = validateViteHubNitroDevRequest(at(`http://rebound.attacker.test:5173${runtimeRoute}`), guard)
    expect(rebound?.status).toBe(403)
    expect(await rebound?.text()).toBe("Forbidden Test Dev host.")
    expect(validateViteHubNitroDevRequest(at(`http://localhost${runtimeRoute}`, { ...json, host: "rebound.attacker.test" }), guard)?.status).toBe(403)
    expect(validateViteHubNitroDevRequest(at(`http://localhost${runtimeRoute}`, { ...json, host: "localhost:5173" }), guard)).toBeUndefined()
  })

  it("keeps the module free of Node value imports, because Worker runtimes load the Nitro-side check", async () => {
    const source = await readFile(new URL("../src/dev-endpoint.ts", import.meta.url), "utf8")
    expect(source).not.toMatch(/^import (?!type )[^\n]*from "node:/m)
  })

  it("accepts the request that the forwarder sends", async () => {
    const dispatchFetch = vi.fn(async (request: Request) => validateViteHubNitroDevRequest(request, guard) ?? Response.json({ ok: true }))
    const response = await forwardViteHubDevRequestToNitro(
      { environments: { nitro: { dispatchFetch } } },
      incoming({ body: "{}", method: "POST" }),
      { ...guard, nitroBaseURL: () => "/app/", runtimeRoute },
    )
    expect(await response.json()).toEqual({ ok: true })
  })

  it("renders a handler that passes the request to the owner export", () => {
    expect(renderViteHubNitroDevHandler({ export: "handleTestDevRequest", module: "@vite-hub/test/runtime/console" })).toBe([
      "import { defineEventHandler } from 'h3'",
      "import { handleTestDevRequest as handleViteHubDevRequest } from \"@vite-hub/test/runtime/console\"",
      "",
      "export default defineEventHandler(event => handleViteHubDevRequest(event.req))",
      "",
    ].join("\n"))
    expect(() => renderViteHubNitroDevHandler({ export: "default; evil()", module: "x" })).toThrow(TypeError)
  })
})
