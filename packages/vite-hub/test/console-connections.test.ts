import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { apiKey } from "@vite-hub/connections"
import { createConnectionsRuntime } from "@vite-hub/connections/server"
import { H3 } from "h3"
import { drizzle } from "drizzle-orm/libsql"
import { createNitro } from "nitro/builder"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"

import { consoleConnectionsKey, consoleConnectionsRegistryKey, consoleConnectionsRootKey, consoleSectionsKey, consoleSectionsRegistryKey, consoleSectionsRootKey, installConsoleConnectionsScope, resolveConsoleConnections } from "../src/console/internal.ts"
import { addConsoleDevframeHandler } from "../src/console/nitro.ts"
import { assertSecureKeyEndpoint, requestConnectionsManagement } from "../src/console/runtime/client/connections-management.ts"
import { addConsoleRpcHandler } from "../src/console/nitro.ts"
import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"
import { consoleConnectionsReturnTo, handleConsoleConnections, installConsoleConnections } from "../src/console/runtime/server/connections.ts"
import connectionsRoute from "../src/console/runtime/server/connections-route.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { assertConsoleProductionAccess, consoleVitePlugin } from "../src/console/vite.ts"

import type { ResolvedAuthViteConfig } from "@vite-hub/auth"
import type { NitroEventHandler } from "nitro/types"
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
    registry: {
      example: async () => ({ default: definition }),
      executor: async () => ({ default: { provider: apiKey({ id: "executor", origins: ["https://executor.sh"] }) } satisfies ConnectionDefinition }),
    },
  })
}

function manage(body: unknown, baseURL = ""): Request {
  return new Request(`${origin}${baseURL}/_vitehub/connections/manage`, { body: JSON.stringify(body), headers: { origin }, method: "POST" })
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
      await writeConsoleNitroPlugin(plugin, root, ["connections"], [], { agents: [], definitions: {} }, [], [], undefined, undefined, false, undefined, undefined, { d1Binding: "JOURNAL" }, "cloudflare-access", true)
      const managed = await readFile(plugin, "utf8")
      expect(managed).toContain(`installConsoleConnections(${JSON.stringify(root)}, {"manage":true})`)
      expect(managed).toContain(`installConsoleSections(${JSON.stringify(root)}, ["connections"], "cloudflare-access")`)
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
    expect(await list.json()).toMatchObject({ admin: true, connections: [{ kind: "oauth2", name: "example", provider: "example", status: "disconnected" }, { kind: "api-key", name: "executor", status: "disconnected" }] })

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

  it("sets an API key through the Console route and records the Console actor", async () => {
    installConsoleSections("/connections-test", ["connections"])
    const connections = runtime()
    installConsoleConnections("/connections-test", { manage: true, runtime: () => connections })
    const saved = await handleConsoleConnections(manage({ action: "set-key", key: "sk_console_marker", name: "executor" }))
    expect(saved.status).toBe(200)
    const body = await saved.text()
    expect(JSON.parse(body)).toMatchObject({ connection: { header: "authorization", kind: "api-key", name: "executor", status: "active" } })
    expect(body).not.toContain("sk_console_marker")
    const activity = await handleConsoleConnections(manage({ action: "activity", name: "executor" }))
    expect(await activity.json()).toMatchObject({ events: [{ action: "connect", actor: { id: "console", kind: "user" }, outcome: "succeeded" }] })
  })

  it.each(["/portal/", "https://cdn.example/portal/"])("preserves the Console mount through OAuth with base %s", async (baseURL) => {
    installConsoleSections("/connections-test", ["connections"])
    const connections = runtime()
    const authorization = vi.spyOn(definition.provider, "authorizationUrl")
    const exchange = vi.spyOn(definition.provider, "exchange")
    try {
      installConsoleConnections("/connections-test", { baseURL, manage: true, runtime: () => connections })
      const nitro: { handlers?: Array<{ handler: string, method?: "get" | "post", route: string }> } = { handlers: [] }
      addConsoleRpcHandler(nitro, "/runtime", { baseURL, connections: true })
      const app = new H3()
      for (const handler of nitro.handlers ?? []) {
        if (handler.handler.endsWith("/connections-route.js")) app.on(handler.method ?? "", handler.route, connectionsRoute)
      }
      const dispatch = (request: Request) => app.fetch(request)
      expect((await dispatch(manage({ action: "list" }, "/portal"))).status).toBe(200)
      expect((await dispatch(manage({ action: "list" }))).status).toBe(404)
      const start = await dispatch(manage({ action: "start", name: "example" }, "/portal"))
      const { url } = v.parse(v.object({ url: v.string() }), await start.json())
      expect(url).toMatch(/^https:\/\/app\.test\/portal\/_vitehub\/connections\/example\/connect\?ticket=/)
      const connect = await dispatch(new Request(url))
      expect(connect.status).toBe(302)
      const redirectUri = `${origin}/portal/_vitehub/connections/example/callback`
      expect(authorization).toHaveBeenCalledWith(expect.objectContaining({ redirectUri }), expect.anything())
      expect(connect.headers.get("set-cookie")).toContain("Path=/portal/_vitehub/connections/example;")
      const state = new URL(connect.headers.get("location") ?? "").searchParams.get("state")
      const cookie = /vitehub_connection_state=([^;]*)/.exec(connect.headers.get("set-cookie") ?? "")?.[1]
      const callback = await dispatch(new Request(`${redirectUri}?code=abc&state=${state}`, { headers: { cookie: `vitehub_connection_state=${cookie}` } }))
      expect(callback.status).toBe(302)
      expect(callback.headers.get("location")).toBe("/portal/_vitehub/connections?connection=example&result=connected")
      expect(exchange).toHaveBeenCalledWith(expect.objectContaining({ redirectUri }), expect.anything())
      expect(callback.headers.get("set-cookie")).toContain("Path=/portal/_vitehub/connections/example;")
      expect((await connections.inspect("example")).status).toBe("active")
      expect(consoleConnectionsReturnTo("example", "failed", baseURL)).toBe("/portal/_vitehub/connections?connection=example&result=failed")
    }
    finally {
      authorization.mockRestore()
      exchange.mockRestore()
    }  })

  it("lets Console users read but not change Connections without manage", async () => {
    installConsoleSections("/connections-test", ["connections"])
    const connections = runtime()
    installConsoleConnections("/connections-test", { runtime: () => connections })
    const list = await handleConsoleConnections(manage({ action: "list" }))
    expect(await list.json()).toMatchObject({ admin: false })
    expect((await handleConsoleConnections(manage({ action: "activity", name: "example" }))).status).toBe(200)
    for (const input of [{ action: "start", name: "example" }, { action: "refresh", name: "example" }, { action: "disconnect", name: "example" }, { action: "set-key", key: "sk_denied", name: "executor" }]) {
      const response = await handleConsoleConnections(manage(input))
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: "CONNECTIONS_DENIED" })
    }
    // The OAuth routes change a Connection too, so they stay closed.
    expect((await handleConsoleConnections(new Request(`${origin}/_vitehub/connections/example/connect?ticket=t`))).status).toBe(403)
    expect((await handleConsoleConnections(new Request(`${origin}/_vitehub/connections/example/callback?code=c&state=s`))).status).toBe(403)
  })

  it("sends an API key from the Console only over HTTPS or to a loopback host", () => {
    for (const url of ["https://app.example/_vitehub/connections/manage", "http://localhost:5173/x", "http://127.0.0.1:3000/x", "http://[::1]:5173/x"]) {
      expect(() => assertSecureKeyEndpoint(new URL(url))).not.toThrow()
    }
    expect(() => assertSecureKeyEndpoint(new URL("http://app.example/_vitehub/connections/manage"))).toThrow("only over HTTPS or on localhost")
  })

  it("validates and fetches the same key endpoint when the document base differs", async () => {
    vi.stubGlobal("location", { href: "http://localhost:5173/console/connections" })
    vi.stubGlobal("document", { baseURI: "http://remote-host/" })
    const request = vi.fn(async () => Response.json({ ok: true }))
    vi.stubGlobal("fetch", request)
    try {
      await requestConnectionsManagement("/_vitehub/connections/manage", "set-key", v.object({ ok: v.boolean() }), { key: "example-key" })
      expect(request).toHaveBeenCalledWith(new URL("http://localhost:5173/_vitehub/connections/manage"), expect.objectContaining({ redirect: "error" }))
      vi.stubGlobal("location", { href: "http://remote-host/console/connections" })
      await expect(requestConnectionsManagement("/_vitehub/connections/manage", "set-key", v.object({ ok: v.boolean() }))).rejects.toThrow("only over HTTPS or on localhost")
      expect(request).toHaveBeenCalledTimes(1)
    }
    finally {
      vi.unstubAllGlobals()
    }
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

  it("requires production Auth rules to protect the mounted Console", () => {
    const auth: ResolvedAuthViteConfig = {
      access: { routes: [{ authorize: true, route: "/_vitehub/**" }, { authorize: true, method: "GET", route: "/api/_vitehub/console/**" }] },
      basePath: "/api/auth",
      database: { mode: "default" },
      definition: { handler: "/server/auth.ts", name: "default", source: "server-auth" },
      rootDir: "/connections-test",
      route: "/api/auth",
      secondaryStorage: false,
    }
    const options = { auth, baseURL: "/portal/", development: false }
    expect(() => assertConsoleProductionAccess({ access: "auth" }, options)).toThrow("/portal/_vitehub/**")
    auth.access.routes = auth.access.routes.map(route => ({ ...route, route: `/portal${route.route}` }))
    expect(() => assertConsoleProductionAccess({ access: "auth" }, options)).not.toThrow()
  })

  it("registers only the Connections routes, so the Console page stays on /_vitehub/**", () => {
    const nitro: { handlers?: Array<{ handler: string, route: string }> } = { handlers: [] }
    addConsoleRpcHandler(nitro, "/runtime", { connections: true })
    expect(nitro.handlers?.filter(handler => handler.route.startsWith("/_vitehub/connections"))).toEqual([
      { handler: "/runtime/server/connections-route.js", method: "post", route: "/_vitehub/connections/manage" },
      { handler: "/runtime/server/connections-route.js", method: "get", route: "/_vitehub/connections/:name/connect" },
      { handler: "/runtime/server/connections-route.js", method: "get", route: "/_vitehub/connections/:name/callback" },
    ])
    const without: { handlers?: Array<{ handler: string, route: string }> } = { handlers: [] }
    addConsoleRpcHandler(without, "/runtime")
    expect(without.handlers?.some(handler => handler.route.startsWith("/_vitehub/connections"))).toBe(false)
  })

  it("rejects a route conflict", () => {
    const nitro = { handlers: [{ handler: "/app/connect.ts", route: "/_vitehub/connections/:name/connect" }] }
    expect(() => addConsoleRpcHandler(nitro, "/runtime", { connections: true })).toThrow("Connections handler")
  })

  it.each(["/", "/portal/"])("dispatches mounted Connections through Nitro with server base %s", async (serverBase) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-connections-host-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({ console: { exposure: "host-managed" }, preset: "cloudflare", sections: ["connections"] })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { base: string, nitro?: { baseURL?: string, handlers: Array<{ handler: string, method?: NitroEventHandler["method"], route: string }>, plugins: string[], publicAssets?: Array<{ baseURL?: string }> }, root: string } = { base: "/portal/", nitro: { baseURL: serverBase, handlers: [], plugins: [] }, root }
      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])
      const routes = config.nitro?.handlers.map(handler => handler.route) ?? []
      const registrationBase = serverBase === "/" ? "/portal" : ""
      expect(routes).toContain(`${registrationBase}/_vitehub/**`)
      expect(routes).toContain(`${registrationBase}/_vitehub/rpc/**`)
      expect(routes).toContain(`${registrationBase}/api/_vitehub/console/client.js`)
      expect(routes).toEqual(expect.arrayContaining([`${registrationBase}/_vitehub/connections/manage`, `${registrationBase}/_vitehub/connections/:name/connect`, `${registrationBase}/_vitehub/connections/:name/callback`]))
      expect(config.nitro?.publicAssets).toEqual(expect.arrayContaining([expect.objectContaining({ baseURL: `${registrationBase}/_vitehub/assets` })]))
      const nitro = await createNitro({ baseURL: serverBase, compatibilityDate: "2026-09-30", handlers: config.nitro?.handlers, logLevel: 0, rootDir: root, scanDirs: [], serverDir: false })
      try {
        installConsoleSections(root, ["connections"])
        const connections = runtime()
        installConsoleConnections(root, { baseURL: "/portal/", manage: true, runtime: () => connections })
        const dispatch = async (request: Request) => {
          const match = nitro.routing.routes.match(request.method, new URL(request.url).pathname)
          const matched = Array.isArray(match) ? match : match ? [match] : []
          const route = matched.find(handler => handler.handler?.endsWith("/connections-route.js"))
          expect(route).toBeDefined()
          if (!route?.handler) throw new TypeError("Expected a registered Connections handler.")
          const { default: handler } = await import(route.handler) as { default: typeof connectionsRoute }
          const app = new H3().all("/**", handler)
          return app.fetch(request)
        }
        const start = await dispatch(manage({ action: "start", name: "example" }, "/portal"))
        const { url } = await start.json() as { url: string }
        const connect = await dispatch(new Request(url))
        const state = new URL(connect.headers.get("location") ?? "").searchParams.get("state")
        const cookie = /vitehub_connection_state=([^;]*)/.exec(connect.headers.get("set-cookie") ?? "")?.[1]
        expect(connect.headers.get("set-cookie")).toContain("Path=/portal/_vitehub/connections/example")
        const callback = await dispatch(new Request(`${origin}/portal/_vitehub/connections/example/callback?code=abc&state=${state}`, { headers: { cookie: `vitehub_connection_state=${cookie}` } }))
        expect(callback.headers.get("location")).toBe("/portal/_vitehub/connections?connection=example&result=connected")
        expect(nitro.routing.routes.match("GET", "/portal/_vitehub/connections")).toBeDefined()
        expect(nitro.routing.routes.match("GET", "/_vitehub/connections")).toBeUndefined()
      }
      finally {
        await nitro.close()
      }
      const generated = await readFile(config.nitro?.plugins[0] ?? "", "utf8")
      expect(generated).toContain(`installConsoleConnections(${JSON.stringify(root)}, {"baseURL":"/portal/"})`)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
