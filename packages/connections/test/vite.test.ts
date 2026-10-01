import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { VITEHUB_NITRO_CONFIG_CONTEXT } from "@vite-hub/internal/build/vite"
import { afterEach, describe, expect, it, vi } from "vitest"

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
  it("prepares discovered Connection declarations without a Vite build", async () => {
    const root = await createTempProject();
    const definition = await writeConnection(root, "custom-server/connections/google.ts");
    const plugin = hubConnections();
    await plugin.api.prepareTypes({ projectRoot: root, serverDirs: [join(root, "custom-server")] });
    const declarations = await readFile(join(root, ".vitehub/types/connections.d.ts"), "utf8");
    expect(declarations).toContain(`"google": typeof import(${JSON.stringify(definition)})`);
    expect(plugin.api.getDefinitions()).toEqual([{ handler: definition, name: "google", source: "server-connections" }]);
  });

  it("writes the registry and mounts the management API in development", async () => {
    const root = await createTempProject()
    const definition = await writeConnection(root, "server/connections/google.ts")
    const plugin = hubConnections({ database: "vite-hub/database/drizzle" })
    const result = await (plugin.config as unknown as ConfigHook)({ nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true }, { command: "serve", mode: "development" })
    const nitro = result.nitro as { alias: Record<string, string>, handlers: Array<{ handler: string, route: string }> }
    const registry = await readFile(nitro.alias[CONNECTIONS_REGISTRY_ID]!, "utf8")
    expect(registry).toContain(JSON.stringify(definition))
    expect(registry).toContain("export const database = () => import(\"vite-hub/database/drizzle\").then(module => module.db)")
    expect(nitro.handlers.map(handler => handler.route)).toEqual(["/_vitehub/connections", "/_vitehub/connections/**"])
    await expect(readFile(nitro.handlers[0]!.handler, "utf8")).resolves.toContain("from \"@vite-hub/connections/server\"")
  })

  it("does not mount the management API in production unless enabled", async () => {
    const root = await createTempProject()
    const build = await (hubConnections().config as unknown as ConfigHook)({ nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true }, { command: "build", mode: "production" })
    expect((build.nitro as { handlers?: unknown[] }).handlers ?? []).toEqual([])
    const managed = await (hubConnections({ management: true }).config as unknown as ConfigHook)({ nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true }, { command: "build", mode: "production" })
    expect((managed.nitro as { handlers: unknown[] }).handlers).toHaveLength(2)
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
