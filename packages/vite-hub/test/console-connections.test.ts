import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { createConnectionsRuntime } from "@vite-hub/connections/server"
import { drizzle } from "drizzle-orm/libsql"
import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"

import { consoleConnectionsKey, consoleConnectionsRegistryKey, consoleConnectionsRootKey, consoleSectionsKey, consoleSectionsRegistryKey, consoleSectionsRootKey, installConsoleConnectionsScope, resolveConsoleConnections } from "../src/console/internal.ts"
import { addConsoleDevframeHandler } from "../src/console/nitro.ts"
import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"
import { consoleConnectionsReturnTo, handleConsoleConnections, installConsoleConnections } from "../src/console/runtime/server/connections.ts"
import connectionsRoute from "../src/console/runtime/server/connections-route.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"

import type { ConnectionDefinition } from "@vite-hub/connections"
import type { ConsoleInvocationScope } from "../src/console/internal.ts"

// SAFETY: Console state uses the same optional symbol keys in runtime and tests.
const scope = globalThis as ConsoleInvocationScope
const symbols = [consoleConnectionsKey, consoleConnectionsRegistryKey, consoleConnectionsRootKey, consoleSectionsKey, consoleSectionsRootKey, consoleSectionsRegistryKey]
const clients: Array<{ close: () => void }> = []
afterEach(() => {
  for (const key of symbols) { Reflect.deleteProperty(scope, key); Reflect.deleteProperty(process, key) }
  for (const client of clients.splice(0)) client.close()
})

const origin = "https://app.test"
const definition: ConnectionDefinition = {
  provider: {
    authorizationUrl: async input => `https://auth.example/authorize?state=${input.state}`,
    exchange: async () => ({ accessToken: "synthetic-access", account: "owner@example.com", expiresAt: Date.now() + 3_600_000, scopes: ["test.read"], tokenType: "Bearer" }),
    id: "example",
    kind: "oauth2",
    origins: ["https://api.example"],
    refresh: async token => token,
    scopes: ["test.read"],
  },
}

function runtime() {
  const client = createClient({ url: ":memory:" })
  clients.push(client)
  const db = drizzle(client)
  return createConnectionsRuntime({
    database: () => db,
    encryptionKey: () => Buffer.from(new Uint8Array(32).fill(3)).toString("base64url"),
    registry: { example: async () => ({ default: definition }) },
  })
}

function manage(body: unknown): Request {
  return new Request(`${origin}/_vitehub/connections/manage`, { body: JSON.stringify(body), headers: { origin }, method: "POST" })
}

describe("Console Connections", () => {
  it("generates the install line only when the section is enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-connections-"))
    try {
      const plugin = join(root, "console.mjs")
      await writeConsoleNitroPlugin(plugin, root, ["connections"], [], { agents: [], definitions: {} }, [], [])
      const generated = await readFile(plugin, "utf8")
      expect(generated).toContain('import { installConsoleConnections } from "vite-hub/console/connections"')
      expect(generated).toContain(`installConsoleConnections(${JSON.stringify(root)})`)
      await writeConsoleNitroPlugin(plugin, root, ["connections"], [], { agents: [], definitions: {} }, [], [], undefined, undefined, false, undefined, undefined, undefined, false, true)
      expect(await readFile(plugin, "utf8")).toContain(`installConsoleConnections(${JSON.stringify(root)}, { manage: true })`)
      await writeConsoleNitroPlugin(plugin, root, ["env"], [], { agents: [], definitions: {} }, [], [])
      expect(await readFile(plugin, "utf8")).not.toContain("installConsoleConnections")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("lists, connects, and records Console actions through the Console routes", async () => {
    installConsoleSections("/connections-test", ["connections"])
    const connections = runtime()
    installConsoleConnections("/connections-test", { manage: true, runtime: () => connections })
    const list = await connectionsRoute({ req: manage({ action: "list" }) })
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({ admin: true, connections: [{ name: "example", provider: "example", status: "disconnected" }] })

    const start = await handleConsoleConnections(manage({ action: "start", name: "example" }))
    const { url } = v.parse(v.object({ url: v.string() }), await start.json())
    expect(url).toMatch(/^https:\/\/app\.test\/_vitehub\/connections\/example\/connect\?ticket=/)

    const connect = await handleConsoleConnections(new Request(url))
    expect(connect.status).toBe(302)
    const state = new URL(connect.headers.get("location") ?? "").searchParams.get("state")
    const cookie = /vitehub_connection_state=([^;]*)/.exec(connect.headers.get("set-cookie") ?? "")?.[1]
    expect(state && cookie).toBeTruthy()
    const callback = await handleConsoleConnections(new Request(`${origin}/_vitehub/connections/example/callback?code=abc&state=${state}`, { headers: { cookie: `vitehub_connection_state=${cookie}` } }))
    expect(callback.status).toBe(302)
    expect(callback.headers.get("location")).toBe(consoleConnectionsReturnTo("example", "connected"))
    expect(callback.headers.get("location")).toBe("/_vitehub/connections?connection=example&result=connected")

    const activity = await handleConsoleConnections(manage({ action: "activity", name: "example" }))
    const body = await activity.text()
    expect(JSON.parse(body)).toMatchObject({ events: [{ action: "connect", actor: { id: "console", kind: "user" }, outcome: "succeeded" }] })
    expect(body).not.toContain("synthetic-access")
  })

  it("lets Console users read but not change Connections without manage", async () => {
    installConsoleSections("/connections-test", ["connections"])
    const connections = runtime()
    installConsoleConnections("/connections-test", { runtime: () => connections })
    const list = await handleConsoleConnections(manage({ action: "list" }))
    expect(await list.json()).toMatchObject({ admin: false })
    expect((await handleConsoleConnections(manage({ action: "activity", name: "example" }))).status).toBe(200)
    for (const input of [{ action: "start", name: "example" }, { action: "refresh", name: "example" }, { action: "disconnect", name: "example" }]) {
      const response = await handleConsoleConnections(manage(input))
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: "CONNECTIONS_DENIED" })
    }
    // The OAuth routes change a Connection too, so they stay closed.
    expect((await handleConsoleConnections(new Request(`${origin}/_vitehub/connections/example/connect?ticket=t`))).status).toBe(403)
    expect((await handleConsoleConnections(new Request(`${origin}/_vitehub/connections/example/callback?code=c&state=s`))).status).toBe(403)
  })

  it("rejects cross-origin management requests", async () => {
    installConsoleSections("/connections-test", ["connections"])
    installConsoleConnections("/connections-test", { runtime })
    const response = await handleConsoleConnections(new Request(`${origin}/_vitehub/connections/manage`, { body: JSON.stringify({ action: "list" }), headers: { origin: "https://other.test" }, method: "POST" }))
    expect(response.status).toBe(403)
  })

  it("returns 404 when the section is disabled", async () => {
    installConsoleConnections("/connections-test", { runtime })
    installConsoleSections("/connections-test", [])
    const response = await handleConsoleConnections(manage({ action: "list" }))
    expect(response.status).toBe(404)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("isolates project handlers across shared process state", () => {
    const processState = {}
    const first: ConsoleInvocationScope = { process: processState }
    const second: ConsoleInvocationScope = { process: processState }
    const a = { handle: async () => new Response("a") }
    const b = { handle: async () => new Response("b") }
    installConsoleConnectionsScope("/first", a, first)
    installConsoleConnectionsScope("/second", b, second)
    expect(resolveConsoleConnections(first)).toBe(a)
    expect(resolveConsoleConnections(second)).toBe(b)
    expect(resolveConsoleConnections({ process: processState })).toBeUndefined()
  })

  it("registers only the Connections routes, so the Console page stays on /_vitehub/**", () => {
    const nitro: { handlers?: Array<{ handler: string, route: string }> } = { handlers: [] }
    addConsoleDevframeHandler(nitro, "/runtime", { connections: true })
    expect(nitro.handlers?.filter(handler => handler.route.startsWith("/_vitehub/connections"))).toEqual([
      { handler: "/runtime/server/connections-route.js", method: "post", route: "/_vitehub/connections/manage" },
      { handler: "/runtime/server/connections-route.js", method: "get", route: "/_vitehub/connections/:name/connect" },
      { handler: "/runtime/server/connections-route.js", method: "get", route: "/_vitehub/connections/:name/callback" },
    ])
    const without: { handlers?: Array<{ handler: string, route: string }> } = { handlers: [] }
    addConsoleDevframeHandler(without, "/runtime")
    expect(without.handlers?.some(handler => handler.route.startsWith("/_vitehub/connections"))).toBe(false)
  })

  it("rejects a route conflict", () => {
    const nitro = { handlers: [{ handler: "/app/connect.ts", route: "/_vitehub/connections/:name/connect" }] }
    expect(() => addConsoleDevframeHandler(nitro, "/runtime", { connections: true })).toThrow("Connections handler")
  })

  it("registers the routes from the Console Vite plugin when the section is on", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-connections-host-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({ console: { exposure: "host-managed" }, preset: "cloudflare", sections: ["connections"] })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { nitro?: { handlers: Array<{ method?: string, route: string }>, plugins: string[] }, root: string } = { root }
      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])
      const routes = config.nitro?.handlers.map(handler => handler.route) ?? []
      expect(routes).toContain("/_vitehub/**")
      expect(routes).toEqual(expect.arrayContaining(["/_vitehub/connections/manage", "/_vitehub/connections/:name/connect", "/_vitehub/connections/:name/callback"]))
      const generated = await readFile(config.nitro?.plugins[0] ?? "", "utf8")
      expect(generated).toContain(`installConsoleConnections(${JSON.stringify(root)})`)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
