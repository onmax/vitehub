import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { VITEHUB_NITRO_CONFIG_CONTEXT } from "@vite-hub/internal/build/vite"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createConnectionsHandler } from "../src/http.ts"
import { ACCESS_TOKEN, createTestRuntime, REFRESH_TOKEN } from "./helpers.ts"
import type { ConnectionsHandlerOptions } from "../src/http.ts"

import { discoverConnectionDefinitions } from "../src/discovery.ts"
import { CONNECTIONS_REGISTRY_ID, hubConnections } from "../src/vite.ts"

const tempDirs: string[] = []

async function createTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-connections-vite-"))
  tempDirs.push(root)
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
  return root
}

async function writeConnection(root: string, path: string): Promise<string> {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, "export default {}\n")
  return file
}

type ConfigHook = (config: Record<PropertyKey, unknown>, environment: { command: "build" | "serve", mode: string }) => Promise<Record<string, unknown>>

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("discoverConnectionDefinitions", () => {
  it("finds server/connections files and .connection suffix files", async () => {
    const root = await createTempProject()
    const google = await writeConnection(root, "server/connections/google.ts")
    const slack = await writeConnection(root, "src/slack.connection.ts")
    expect(discoverConnectionDefinitions({ rootDir: root })).toEqual([
      { handler: google, name: "google", source: "server-connections" },
      { handler: slack, name: "slack", source: "vite-suffix" },
    ])
  })
})

describe("hubConnections", () => {
  it("writes the registry and mounts the management API in development", async () => {
    const root = await createTempProject()
    const definition = await writeConnection(root, "server/connections/google.ts")
    const plugin = hubConnections({ database: "vite-hub/database/drizzle" })
    const result = await (plugin.config as unknown as ConfigHook)({ base: "/assets/", nitro: { baseURL: "/portal/" }, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true }, { command: "serve", mode: "development" })
    const nitro = result.nitro as { alias: Record<string, string>, handlers: Array<{ handler: string, method?: string, route: string }> }
    const registry = await readFile(nitro.alias[CONNECTIONS_REGISTRY_ID]!, "utf8")
    await expect(readFile(nitro.handlers[0]!.handler, "utf8")).resolves.toContain('?? "/portal/_vitehub/connections"')
    expect(registry).toContain(JSON.stringify(definition))
    expect(registry).toContain("export const database = () => import(\"vite-hub/database/drizzle\").then(module => module.db)")
    expect(nitro.handlers.map(handler => `${handler.method} ${handler.route}`)).toEqual([
      "post /_vitehub/connections",
      "get /_vitehub/connections/connect/**",
      "get /_vitehub/connections/callback",
    ])
    await expect(readFile(nitro.handlers[0]!.handler, "utf8")).resolves.toContain("from \"@vite-hub/connections/server\"")
  })

  it.each(["/", "./", "https://cdn.example/assets/", "/assets/"])("uses the server mount for asset base %s", async (base) => {
    const root = await createTempProject()
    const plugin = hubConnections()
    const result = await (plugin.config as unknown as ConfigHook)({ base, nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true }, { command: "serve", mode: "development" })
    const nitro = result.nitro as { handlers: Array<{ handler: string }> }
    await expect(readFile(nitro.handlers[0]!.handler, "utf8")).resolves.toContain('?? "/_vitehub/connections"')
  })

  it.each([false, true])("invokes generated output under a runtime mount override with actor=%s", async (actor) => {
    const root = await createTempProject()
    const test = createTestRuntime()
    vi.stubGlobal("vitehubConnectionsMountTest", (options: ConnectionsHandlerOptions) => createConnectionsHandler({ ...options, runtime: () => test.runtime }))
    await writeFile(join(root, "server.mjs"), "export const createConnectionsHandler = options => globalThis.vitehubConnectionsMountTest(options)\n")
    await writeFile(join(root, "actor.mjs"), "export default () => 'user:owner'\n")
    const plugin = hubConnections({ ...(actor ? { actor: join(root, "actor.mjs") } : {}), importBase: root, management: true })
    const result = await (plugin.config as unknown as ConfigHook)({ nitro: { baseURL: "/build-time/" }, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true }, { command: "build", mode: "production" })
    const handlerFile = (result.nitro as { handlers: Array<{ handler: string }> }).handlers[0]!.handler
    // SAFETY: The generated module default export is the server event handler created above.
    const handler = (await import(handlerFile) as { default: (event: { req: Request }) => Promise<Response> }).default
    const mount = "http://localhost/runtime-base/_vitehub/connections"
    const list = await handler({ req: new Request(mount, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "list" }) }) })
    expect(list.status).toBe(200)
    const start = await handler({ req: new Request(`${mount}/connect/mail`) })
    expect(start.status).toBe(302)
    const location = new URL(start.headers.get("location")!)
    expect(location.searchParams.get("redirect_uri")).toBe(`${mount}/callback`)
    expect(start.headers.get("set-cookie")).toContain("Path=/runtime-base/_vitehub/connections;")
    const state = location.searchParams.get("state")!
    test.provider.tokenResponses.push({ body: { access_token: ACCESS_TOKEN, expires_in: 3600, id_token: "account-1", refresh_token: REFRESH_TOKEN } })
    const callback = await handler({ req: new Request(`${mount}/callback?code=code-1&state=${state}`, { headers: { cookie: `vitehub_connection_state=${state}` } }) })
    expect(callback.status).toBe(200)
    expect(callback.headers.get("set-cookie")).toContain("Path=/runtime-base/_vitehub/connections;")
    expect(await test.runtime.inspect("mail")).toMatchObject({ status: "connected" })
  })

  it("passes the server event to the actor module", async () => {
    const root = await createTempProject()
    await writeFile(join(root, "server.mjs"), "export function createConnectionsHandler(options) { return async request => new Response(`${await options.actor(request)} ${request.url}`) }\n")
    await writeFile(join(root, "actor.mjs"), "export default event => `user:${event.req.headers.get(\"x-user\")}`\n")
    const plugin = hubConnections({ actor: join(root, "actor.mjs"), importBase: root })
    const result = await (plugin.config as unknown as ConfigHook)({ nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true }, { command: "serve", mode: "development" })
    const handlerFile = (result.nitro as { handlers: Array<{ handler: string }> }).handlers[0]!.handler
    await expect(readFile(handlerFile, "utf8")).resolves.toContain(`import actor from ${JSON.stringify(join(root, "actor.mjs"))}`)
    const handler = (await import(handlerFile) as { default: (event: { req: Request }) => Promise<Response> }).default
    const response = await handler({ req: new Request("http://localhost/_vitehub/connections", { headers: { "x-user": "ada" } }) })
    expect(await response.text()).toBe("user:ada http://localhost/_vitehub/connections")
  })

  it("does not mount the management API in production unless enabled", async () => {
    const root = await createTempProject()
    const build = await (hubConnections().config as unknown as ConfigHook)({ nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true }, { command: "build", mode: "production" })
    expect((build.nitro as { handlers?: unknown[] }).handlers ?? []).toEqual([])
    const managed = await (hubConnections({ management: true }).config as unknown as ConfigHook)({ nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true }, { command: "build", mode: "production" })
    expect((managed.nitro as { handlers: unknown[] }).handlers).toHaveLength(3)
  })

  it("writes registry types and refreshes on hot update", async () => {
    const root = await createTempProject()
    const plugin = hubConnections()
    await (plugin.configResolved as (config: { root: string }) => Promise<void>)({ root })
    const added = await writeConnection(root, "server/connections/slack.ts")
    const invalidateModule = vi.fn()
    await (plugin.handleHotUpdate as (context: unknown) => Promise<void>)({
      file: added,
      server: { config: { root }, moduleGraph: { getModuleById: () => ({}), invalidateModule } },
    })
    expect(invalidateModule).toHaveBeenCalled()
    await expect(readFile(join(root, ".vitehub/types/connections.d.ts"), "utf8")).resolves.toContain(`"slack": typeof import(${JSON.stringify(added)})`)
    expect(plugin.api.getDefinitions().map(definition => definition.name)).toEqual(["slack"])
  })
})
