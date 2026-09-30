import { describe, expect, it, vi } from "vitest"

import { defineConnection } from "../src/definition.ts"
import { createConnectionsHandler } from "../src/http.ts"
import { apiKey } from "../src/providers/api-key.ts"
import { expectCode, mockFetch, readOperation, rows, setupRuntime, writeOperation } from "./helpers.ts"

import type { ConnectionsAccess } from "../src/http.ts"
import type { ConnectionActor, ConnectionDefinition } from "../src/types.ts"

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

describe("apiKey()", () => {
  it("sends a Bearer authorization header by default", () => {
    expect(apiKey()).toEqual({ header: "authorization", id: "api-key", kind: "api-key", scheme: "Bearer", scopes: [] })
  })

  it("uses a custom header without a scheme", () => {
    expect(apiKey({ header: "X-Api-Key", id: "executor" })).toEqual({ header: "x-api-key", id: "executor", kind: "api-key", scopes: [] })
  })

  it("rejects header names and schemes that are not HTTP tokens", () => {
    expect(() => apiKey({ header: "x-api-key\r\nx-other" })).toThrow("Invalid Connection request.")
    expect(() => apiKey({ header: "" })).toThrow("Invalid Connection request.")
    expect(() => apiKey({ scheme: "Bearer token" })).toThrow("Invalid Connection request.")
  })

  it("is a valid Connection provider", () => {
    expect(defineConnection({ provider: apiKey() }).provider.kind).toBe("api-key")
  })

  it("rejects malformed API key providers from JavaScript definitions", () => {
    // SAFETY: JavaScript definitions are not type-checked; these shapes stand in for them.
    const untyped = (provider: unknown) => ({ provider }) as unknown as ConnectionDefinition
    for (const provider of [
      { id: "custom", kind: "api-key", scopes: [] },
      { header: "x-api-key\r\nx", id: "custom", kind: "api-key", scopes: [] },
      { header: "X-Api-Key", id: "custom", kind: "api-key", scopes: [] },
      { header: "x-api-key", id: "", kind: "api-key", scopes: [] },
      { header: "authorization", id: "custom", kind: "api-key", scheme: "Bearer token", scopes: [] },
      { header: "authorization", id: "custom", kind: "api-key", scopes: [], verify: "yes" },
    ]) {
      expect(() => defineConnection(untyped(provider))).toThrow("Invalid Connection request.")
    }
  })
})

describe("API key Connections", () => {
  it("stores the key sealed and sends it with each request", async () => {
    const upstream = api()
    const { db, name, runtime } = setupRuntime({ definition: { provider: apiKey({ header: "x-api-key" }) }, fetch: upstream.fetch })

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
    const definition: ConnectionDefinition = { access: { agents: { support: { allow: ["test.items.create"] } } }, provider: apiKey() }
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
    const { name, runtime } = setupRuntime({ definition: { provider: apiKey() }, fetch: upstream.fetch })
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
    const { name, runtime } = setupRuntime({ definition: { provider: apiKey({ verify }) } })

    await expect(runtime.setKey(name, secretKey, { actor: owner })).resolves.toMatchObject({ account: "acme workspace", status: "active" })
    await expectCode(runtime.setKey(name, "wrong-key", { actor: owner }), "CONNECTIONS_KEY_REJECTED")
    expect(verify).toHaveBeenCalledWith("wrong-key", expect.objectContaining({ fetch: expect.any(Function) }))
    await expect(runtime.inspect(name)).resolves.toMatchObject({ account: "acme workspace", status: "active" })
    const [failed] = await runtime.activity({})
    expect(failed).toMatchObject({ action: "connect", error: "CONNECTIONS_KEY_REJECTED", outcome: "failed" })
  })

  it("rejects keys with whitespace or control characters", async () => {
    const { name, runtime } = setupRuntime({ definition: { provider: apiKey() } })
    for (const key of ["", "two words", "line\nbreak", "tab\tkey", "x".repeat(8193)]) {
      await expectCode(runtime.setKey(name, key, { actor: owner }), "CONNECTIONS_INVALID")
    }
  })

  it("does not accept a key for an OAuth Connection", async () => {
    const { name, runtime } = setupRuntime()
    await expectCode(runtime.setKey(name, secretKey, { actor: owner }), "CONNECTIONS_UNSUPPORTED")
  })

  it("disconnects and deletes the key", async () => {
    const { name, runtime, store } = setupRuntime({ definition: { provider: apiKey() } })
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
    const { name, runtime } = setupRuntime({ definition: { provider: apiKey({ header: "x-api-key" }) }, fetch: upstream.fetch })
    await runtime.setKey(name, secretKey, { actor: owner })

    await expect(runtime.call(name, readOperation, { id: "7" }, { actor: server })).resolves.toEqual({ id: "7", ok: true })
    expect(upstream.mock.mock.calls.map(([input, init]) => [String(input), new Headers(init?.headers).get("x-api-key"), init?.redirect])).toEqual([
      ["https://api.example/items/7?secret=query-value", secretKey, "manual"],
      ["https://elsewhere.example/items/7", null, "manual"],
    ])
  })

  it("keeps the key on a same-origin redirect and turns a 303 into GET", async () => {
    const upstream = redirecting("/items/created", 303)
    const definition: ConnectionDefinition = { access: { server: { allow: ["*"] } }, provider: apiKey() }
    const { name, runtime } = setupRuntime({ definition, fetch: upstream.fetch })
    await runtime.setKey(name, secretKey, { actor: owner })

    await runtime.call(name, writeOperation, { name: "x" }, { actor: server })
    expect(upstream.calls.map(call => [call.method, call.url, call.authorization, call.body])).toEqual([
      ["POST", "https://api.example/items", `Bearer ${secretKey}`, JSON.stringify({ name: "x" })],
      ["GET", "https://api.example/items/created", `Bearer ${secretKey}`, undefined],
    ])
  })

  it("sends one request when the caller handles redirects", async () => {
    const upstream = redirecting("https://elsewhere.example/")
    const { name, runtime } = setupRuntime({ definition: { provider: apiKey() }, fetch: upstream.fetch })
    await runtime.setKey(name, secretKey, { actor: owner })

    const response = await runtime.fetch(name, "https://api.example/items", { redirect: "manual" }, { actor: server })
    expect(response.status).toBe(302)
    expect(upstream.calls).toHaveLength(1)
  })

  it("does not use an OAuth grant for an API key Connection with the same provider id", async () => {
    const upstream = api()
    const { name, runtime, store } = setupRuntime({ definition: { provider: apiKey({ id: "fake" }) }, fetch: upstream.fetch })
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
    const context = setupRuntime({ definition: { provider: apiKey() }, name: "executor" })
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
