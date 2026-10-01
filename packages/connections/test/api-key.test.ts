import { describe, expect, it, vi } from "vitest"

import { defineConnection } from "../src/definition.ts"
import { createConnectionsHandler } from "../src/http.ts"
import { apiKey } from "../src/providers/api-key.ts"

import type { ApiKeyProviderOptions } from "../src/providers/api-key.ts"
import { createConnectionsRuntime } from "../src/runtime/core.ts"

import { expectCode, fakeProvider, mockFetch, readOperation, rows, setupRuntime, writeOperation } from "./helpers.ts"

import type { ConnectionsAccess } from "../src/http.ts"
import type { ConnectionActor, ConnectionDefinition } from "../src/types.ts"

/** `apiKey()` for the test API origin. */
function key(options: Partial<ApiKeyProviderOptions> = {}) {
  return apiKey({ origins: ["https://api.example"], ...options })
}

const secretKey = "sk_live_api-key-marker"
const owner: ConnectionActor = { id: "owner", kind: "user" }
const server: ConnectionActor = { id: "server", kind: "service" }
const agent: ConnectionActor = { id: "support", kind: "agent" }
const origin = "https://app.example"

function api() {
  return mockFetch((url, init) => Response.json(init.method === "POST" ? { name: "created" } : { id: url.pathname.split("/").pop(), ok: true }))
}

function sentHeaders(mock: ReturnType<typeof api>["mock"], index = 0): Headers {
  return new Headers(mock.mock.calls[index]?.[1]?.headers)
}

describe("key()", () => {
  it("sends a Bearer authorization header by default", () => {
    expect(key()).toEqual({ header: "authorization", id: "api-key", kind: "api-key", origins: ["https://api.example"], scheme: "Bearer", scopes: [] })
  })

  it("uses a custom header without a scheme", () => {
    expect(key({ header: "X-Api-Key", id: "executor" })).toEqual({ header: "x-api-key", id: "executor", kind: "api-key", origins: ["https://api.example"], scopes: [] })
  })

  it("sends a bare key with an empty scheme", () => {
    expect(key({ scheme: "" })).not.toHaveProperty("scheme")
  })

  it("rejects header names and schemes that are not HTTP tokens", () => {
    expect(() => key({ header: "x-api-key\r\nx-other" })).toThrow("Invalid Connection request.")
    expect(() => key({ header: "" })).toThrow("Invalid Connection request.")
    expect(() => key({ scheme: "Bearer token" })).toThrow("Invalid Connection request.")
    expect(() => key({ id: "api-key:foo" })).toThrow("Invalid Connection request.")
    expect(() => key({ origins: ["http://api.example.com"] })).toThrow("Invalid Connection request.")
    expect(() => apiKey({ origins: [] })).toThrow("Invalid Connection request.")
  })

  it("is a valid Connection provider", () => {
    expect(defineConnection({ provider: key() }).provider.kind).toBe("api-key")
  })

  it("rejects malformed API key providers from JavaScript definitions", () => {
    // SAFETY: JavaScript definitions are not type-checked; these shapes stand in for them.
    const untyped = (provider: unknown) => ({ provider }) as unknown as ConnectionDefinition
    for (const provider of [
      { id: "custom", kind: "api-key", origins: ["https://api.example"], scopes: [] },
      { header: "x-api-key\r\nx", id: "custom", kind: "api-key", origins: ["https://api.example"], scopes: [] },
      { header: "X-Api-Key", id: "custom", kind: "api-key", origins: ["https://api.example"], scopes: [] },
      { header: "x-api-key", id: "", kind: "api-key", origins: ["https://api.example"], scopes: [] },
      { header: "authorization", id: "custom", kind: "api-key", origins: ["https://api.example"], scheme: "Bearer token", scopes: [] },
      { header: "authorization", id: "custom", kind: "api-key", origins: ["https://api.example"], scopes: [], verify: "yes" },
      { header: "authorization", id: "custom", kind: "api-key", origins: ["https://api.example"] },
      { header: "authorization", id: "custom", kind: "api-key", origins: ["https://api.example"], scopes: "read" },
      { header: "authorization", id: "custom", kind: "api-key", origins: ["https://api.example"], scopes: [123] },
    ]) {
      expect(() => defineConnection(untyped(provider))).toThrow("Invalid Connection request.")
    }
  })
})

describe("API key Connections", () => {
  it.each(["direct", "default"])("validates %s registry exports before accessing stored grants", async (form) => {
    for (const provider of [
      { ...fakeProvider().provider, id: "api-key:foo" },
      { ...key(), id: "api-key:foo" },
      { ...key(), scopes: undefined },
    ]) {
      const database = vi.fn(() => undefined)
      const definition = { provider }
      const runtime = createConnectionsRuntime({
        database,
        encryptionKey: () => new Uint8Array(32),
        registry: { api: async () => form === "direct" ? definition : { default: definition } },
      })
      await expectCode(runtime.inspect("api"), "CONNECTIONS_INVALID")
      expect(database).not.toHaveBeenCalled()
    }
  })

  it("stores the key sealed and sends it with each request", async () => {
    const upstream = api()
    const { db, name, runtime } = setupRuntime({ definition: { provider: key({ header: "x-api-key" }) }, fetch: upstream.fetch })

    await expect(runtime.inspect(name)).resolves.toMatchObject({ header: "x-api-key", kind: "api-key", scopes: [], status: "disconnected" })
    await expect(runtime.setKey(name, secretKey, { actor: owner })).resolves.toMatchObject({ kind: "api-key", provider: "api-key", status: "active" })
    await expect(runtime.call(name, readOperation, { id: "7" }, { actor: server })).resolves.toEqual({ id: "7", ok: true })

    const headers = sentHeaders(upstream.mock)
    expect(headers.get("x-api-key")).toBe(secretKey)
    expect(headers.get("authorization")).toBeNull()
    expect(JSON.stringify(await rows(db, "vitehub_connection_grants"))).not.toContain(secretKey)
    const [event] = await runtime.activity({})
    expect(event).toMatchObject({ action: "connect", actor: owner, outcome: "succeeded" })
    expect(JSON.stringify(await rows(db, "vitehub_connection_activity"))).not.toContain(secretKey)
  })

  it("applies access rules and audit like OAuth Connections", async () => {
    const upstream = api()
    const definition: ConnectionDefinition = { access: { agents: { support: { allow: ["test.items.create"] } } }, provider: key() }
    const { name, runtime } = setupRuntime({ definition, fetch: upstream.fetch })
    await runtime.setKey(name, secretKey, { actor: owner })

    await expectCode(runtime.call(name, writeOperation, { name: "x" }, { actor: server }), "CONNECTIONS_DENIED")
    await expect(runtime.call(name, writeOperation, { name: "x" }, { actor: agent })).resolves.toEqual({ created: "created" })
    expect(sentHeaders(upstream.mock).get("authorization")).toBe(`Bearer ${secretKey}`)
    const outcomes = (await runtime.activity({ connection: name })).map(event => `${event.action}:${event.outcome}:${event.actor.id}`)
    expect(outcomes).toEqual(["call:succeeded:support", "call:denied:server", "connect:succeeded:owner"])
  })

  it("replaces the key and does not refresh or retry a 401", async () => {
    const upstream = mockFetch(() => new Response(null, { status: 401 }))
    const { name, runtime } = setupRuntime({ definition: { provider: key() }, fetch: upstream.fetch })
    await runtime.setKey(name, "first-key", { actor: owner })
    await runtime.setKey(name, secretKey, { actor: owner })

    const response = await runtime.fetch(name, "https://api.example/items", undefined, { actor: server })
    expect(response.status).toBe(401)
    expect(upstream.calls.map(call => call.authorization)).toEqual([`Bearer ${secretKey}`])
    await expect(runtime.inspect(name)).resolves.toMatchObject({ status: "active" })
    await expectCode(runtime.refresh(name, { actor: owner }), "CONNECTIONS_UNSUPPORTED")
    await expectCode(runtime.start(name, { actor: owner, origin }), "CONNECTIONS_UNSUPPORTED")
  })

  it("verifies a new key and keeps the old key when the check fails", async () => {
    const verify = vi.fn(async (key: string) => key === secretKey ? { account: "acme workspace" } : false as const)
    const { name, runtime } = setupRuntime({ definition: { provider: key({ verify }) } })

    await expect(runtime.setKey(name, secretKey, { actor: owner })).resolves.toMatchObject({ account: "acme workspace", status: "active" })
    await expectCode(runtime.setKey(name, "wrong-key", { actor: owner }), "CONNECTIONS_KEY_REJECTED")
    expect(verify).toHaveBeenCalledWith("wrong-key", expect.objectContaining({ fetch: expect.any(Function) }))
    await expect(runtime.inspect(name)).resolves.toMatchObject({ account: "acme workspace", status: "active" })
    const [failed] = await runtime.activity({})
    expect(failed).toMatchObject({ action: "connect", error: "CONNECTIONS_KEY_REJECTED", outcome: "failed" })
  })

  it("rejects malformed verification results before replacing the existing key", async () => {
    for (const invalid of [{ account: 123 }, null, undefined, true, "accepted", []]) {
      // SAFETY: JavaScript providers can return values outside the declared verifier contract.
      const verify = vi.fn(async (candidate: string) => candidate === secretKey ? { account: "original" } : invalid) as ApiKeyProviderOptions["verify"]
      const upstream = api()
      const { name, runtime } = setupRuntime({ definition: { provider: key({ verify }) }, fetch: upstream.fetch })
      await runtime.setKey(name, secretKey, { actor: owner })
      await expectCode(runtime.setKey(name, "replacement", { actor: owner }), "CONNECTIONS_INVALID")
      await expect(runtime.inspect(name)).resolves.toMatchObject({ account: "original", status: "active" })
      await runtime.fetch(name, "https://api.example/items", undefined, { actor: server })
      expect(upstream.calls[0]?.authorization).toBe(`Bearer ${secretKey}`)
    }
  })

  it("rejects keys with whitespace or control characters", async () => {
    const { name, runtime } = setupRuntime({ definition: { provider: key() } })
    for (const key of ["", "two words", "line\nbreak", "tab\tkey", "x".repeat(8193)]) {
      await expectCode(runtime.setKey(name, key, { actor: owner }), "CONNECTIONS_INVALID")
    }
  })

  it("does not accept a key for an OAuth Connection", async () => {
    const { name, runtime } = setupRuntime()
    await expectCode(runtime.setKey(name, secretKey, { actor: owner }), "CONNECTIONS_UNSUPPORTED")
  })

  it("disconnects and deletes the key", async () => {
    const { name, runtime, store } = setupRuntime({ definition: { provider: key() } })
    await runtime.setKey(name, secretKey, { actor: owner })
    await expect(runtime.disconnect(name, { actor: owner })).resolves.toMatchObject({ status: "disconnected" })
    expect(await store.grant(name)).toBeUndefined()
  })
})

describe("API key credentials", () => {
  function redirecting(location: string, status = 302) {
    return mockFetch((url, _init, index) => index === 0 ? new Response(null, { headers: { location }, status }) : Response.json({ id: url.pathname.split("/").pop(), ok: true }))
  }

  it("drops the key on a cross-origin redirect", async () => {
    const upstream = redirecting("https://elsewhere.example/items/7")
    const { name, runtime } = setupRuntime({ definition: { provider: key({ header: "x-api-key" }) }, fetch: upstream.fetch })
    await runtime.setKey(name, secretKey, { actor: owner })

    await expect(runtime.call(name, readOperation, { id: "7" }, { actor: server })).resolves.toEqual({ id: "7", ok: true })
    expect(upstream.mock.mock.calls.map(([input, init]) => [String(input), new Headers(init?.headers).get("x-api-key"), init?.redirect])).toEqual([
      ["https://api.example/items/7?secret=query-value", secretKey, "manual"],
      ["https://elsewhere.example/items/7", null, "manual"],
    ])
  })

  it("keeps the key on a same-origin redirect and turns a 303 into GET", async () => {
    const upstream = redirecting("/items/created", 303)
    const definition: ConnectionDefinition = { access: { server: { allow: ["*"] } }, provider: key() }
    const { name, runtime } = setupRuntime({ definition, fetch: upstream.fetch })
    await runtime.setKey(name, secretKey, { actor: owner })

    await runtime.fetch(name, "https://api.example/items", { body: "raw", headers: { "content-encoding": "gzip", "content-language": "en", "content-type": "text/plain" }, method: "POST" }, { actor: server })
    const rewritten = new Headers(upstream.mock.mock.calls[1]?.[1]?.headers)
    expect(["content-encoding", "content-language", "content-type"].map(header => rewritten.get(header))).toEqual([null, null, null])
    upstream.mock.mockClear()
    upstream.calls.length = 0

    await runtime.call(name, writeOperation, { name: "x" }, { actor: server })
    expect(upstream.calls.map(call => [call.method, call.url, call.authorization, call.body])).toEqual([
      ["POST", "https://api.example/items", `Bearer ${secretKey}`, JSON.stringify({ name: "x" })],
      ["GET", "https://api.example/items/created", `Bearer ${secretKey}`, undefined],
    ])
  })

  it("drops cookies and other credentials on a cross-origin redirect", async () => {
    const upstream = redirecting("https://elsewhere.example/next", 307)
    const { name, runtime } = setupRuntime({ definition: { provider: key({ header: "x-api-key" }) }, fetch: upstream.fetch })
    await runtime.setKey(name, secretKey, { actor: owner })

    await runtime.fetch(name, "https://api.example/items", { headers: { "authorization": "Basic caller", "cookie": "session=1", "proxy-authorization": "Basic proxy", "x-trace": "t1" } }, { actor: server })
    const second = new Headers(upstream.mock.mock.calls[1]?.[1]?.headers)
    expect([...second.keys()].sort()).toEqual(["x-trace"])
  })

  it("keeps the credential removed after a redirect chain leaves the first origin", async () => {
    const upstream = mockFetch((url, _init, index) => index === 0
      ? new Response(null, { headers: { location: "https://elsewhere.example/hop" }, status: 307 })
      : index === 1
        ? new Response(null, { headers: { location: "https://api.example/admin/delete" }, status: 307 })
        : Response.json({ ok: true, path: url.pathname }))
    const { name, runtime } = setupRuntime({ definition: { access: { server: { allow: ["*"] } }, provider: key() }, fetch: upstream.fetch })
    await runtime.setKey(name, secretKey, { actor: owner })

    await runtime.fetch(name, "https://api.example/items", { body: "x", headers: { cookie: "session=1" }, method: "POST" }, { actor: server })
    expect(upstream.calls.map(call => [call.url, call.authorization])).toEqual([
      ["https://api.example/items", `Bearer ${secretKey}`],
      ["https://elsewhere.example/hop", null],
      ["https://api.example/admin/delete", null],
    ])
    expect(new Headers(upstream.mock.mock.calls[2]?.[1]?.headers).get("cookie")).toBeNull()
  })

  it("never replays a stream body on a redirect that keeps the method", async () => {
    const upstream = redirecting("/items/moved", 302)
    const definition: ConnectionDefinition = { access: { server: { allow: ["*"] } }, provider: key() }
    const { name, runtime } = setupRuntime({ definition, fetch: upstream.fetch })
    await runtime.setKey(name, secretKey, { actor: owner })

    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data")); controller.close() } })
    // SAFETY: Node needs `duplex` for a stream body. The RequestInit type in this project does not declare it.
    const response = await runtime.fetch(name, "https://api.example/items", { body, duplex: "half", method: "PUT" } as RequestInit, { actor: server })
    expect(response.status).toBe(302)
    expect(upstream.calls).toHaveLength(1)
  })

  it("sends one request when the caller handles redirects", async () => {
    const upstream = redirecting("https://elsewhere.example/")
    const { name, runtime } = setupRuntime({ definition: { provider: key() }, fetch: upstream.fetch })
    await runtime.setKey(name, secretKey, { actor: owner })

    const response = await runtime.fetch(name, "https://api.example/items", { redirect: "manual" }, { actor: server })
    expect(response.status).toBe(302)
    expect(upstream.calls).toHaveLength(1)
  })

  it("does not use an OAuth grant for an API key Connection with the same provider id", async () => {
    const upstream = api()
    const { name, runtime, store } = setupRuntime({ definition: { provider: key({ id: "fake" }) }, fetch: upstream.fetch })
    await store.write({ name, provider: "fake", tokens: { accessToken: "oauth-access-marker", scopes: [], tokenType: "Bearer" } })

    expect(await runtime.inspect(name)).toMatchObject({ lastError: "CONNECTIONS_PROVIDER_CHANGED", status: "needs-reconnect" })
    await expectCode(runtime.call(name, readOperation, { id: "1" }, { actor: server }), "CONNECTIONS_NEEDS_RECONNECT")
    expect(upstream.calls).toEqual([])
    await runtime.setKey(name, secretKey, { actor: owner })
    expect(await runtime.inspect(name)).toMatchObject({ status: "active" })
  })
})

describe("API key management route", () => {
  function setup(access: ConnectionsAccess) {
    const context = setupRuntime({ definition: { provider: key() }, name: "executor" })
    const handler = createConnectionsHandler({ authenticate: async () => access, runtime: context.runtime })
    const manage = (input: unknown) => handler(new Request(`${origin}/_vitehub/connections/manage`, { body: JSON.stringify(input), headers: { origin }, method: "POST" }))
    return { ...context, manage }
  }

  it("sets the key for admins without echoing it", async () => {
    const { manage, store } = setup({ actor: owner, admin: true })
    const response = await manage({ action: "set-key", key: secretKey, name: "executor" })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(JSON.parse(body)).toMatchObject({ connection: { kind: "api-key", name: "executor", status: "active" } })
    expect(body).not.toContain(secretKey)
    expect(await store.grant("executor")).toBeDefined()
  })

  it("denies non-admins and maps key errors to 400", async () => {
    const viewer = setup({ actor: { id: "viewer", kind: "user" }, admin: false })
    const denied = await viewer.manage({ action: "set-key", key: secretKey, name: "executor" })
    expect(denied.status).toBe(403)
    expect(await viewer.store.grant("executor")).toBeUndefined()

    const { manage } = setup({ actor: owner, admin: true })
    const invalid = await manage({ action: "set-key", key: "two words", name: "executor" })
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).not.toContain("two words")
    expect((await manage({ action: "start", name: "executor" })).status).toBe(400)
    expect((await manage({ action: "set-key", key: "", name: "executor" })).status).toBe(400)
  })
})
