import { resolve } from "node:path"

import { createNoExternalMerger, hasNitroConfigContext, isServerEnvironment, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import { discoverConnectionDefinitions } from "./discovery.ts"

import type { ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { Plugin, ResolvedConfig } from "vite"
import type { DiscoveredConnectionDefinition } from "./types.ts"

export const CONNECTIONS_REGISTRY_ID = "#vitehub/connections/registry"
export const CONNECTIONS_VITE_PLUGIN_NAME = "@vite-hub/connections/vite"

const resolvedConnectionsRegistryId = `\0${CONNECTIONS_REGISTRY_ID}`
const mergeNoExternal = createNoExternalMerger("@vite-hub/connections")

export interface ConnectionsVitePluginOptions {
  /**
   * Module that identifies who manages Connections, for example the signed-in Console user.
   * Its default export receives the server event and returns `user:<id>`, or `undefined` for `user:local`.
   */
  actor?: string
  /** Module that exports the ViteHub Database as `db`. Set `false` when the app has no database. */
  database?: string | false
  /** Package that the generated handler imports from. */
  importBase?: string
  /**
   * Mount the management API in production. The development server always mounts it.
   * Enable it only behind authentication, for example Console auth.
   */
  management?: boolean
  projectRoot?: string
}

/** Options for `vitehub({ connections })`. */
export type ConnectionsModuleOptions = Pick<ConnectionsVitePluginOptions, "management" | "projectRoot">

export interface ConnectionsVitePluginAPI {
  getDefinitions: () => DiscoveredConnectionDefinition[]
  refresh: () => DiscoveredConnectionDefinition[]
}

export type ConnectionsVitePlugin = Plugin<ConnectionsVitePluginAPI> & {
  api: ConnectionsVitePluginAPI
  vitehub: { cli: () => Promise<ViteHubCliContributor> }
}

function renderRegistry(definitions: DiscoveredConnectionDefinition[], database: string | false): string {
  return [
    "const registry = Object.create(null)",
    ...definitions.map(definition => `registry[${JSON.stringify(definition.name)}] = () => import(${JSON.stringify(definition.handler)})`),
    "",
    database
      ? `export const database = () => import(${JSON.stringify(database)}).then(module => module.db)`
      : "export const database = undefined",
    "export default registry",
    "",
  ].join("\n")
}

function renderRegistryTypes(definitions: DiscoveredConnectionDefinition[]): string {
  return [
    "declare global {",
    "  interface ViteHubConnectionDefinitionModules {",
    ...definitions.map(definition => `    ${JSON.stringify(definition.name)}: typeof import(${JSON.stringify(definition.handler)})`),
    "  }",
    "}",
    "",
    "export {}",
    "",
  ].join("\n")
}

function renderHandler(importBase: string, actor: string | undefined, basePath: string): string {
  return [
    `import { createConnectionsHandler } from ${JSON.stringify(`${importBase}/server`)}`,
    ...(actor ? [`import actor from ${JSON.stringify(actor)}`] : []),
    "",
    "export default (event: { req: Request }) => {",
    `  const basePath = new URL(event.req.url).pathname.match(/^(.*?\\/_vitehub\\/connections)(?:\\/connect\\/.*|\\/callback)?\\/?$/)?.[1] ?? ${JSON.stringify(basePath)}`,
    `  return createConnectionsHandler({ ${actor ? "actor: () => actor(event), " : ""}basePath })(event.req)`,
    "}",
    "",
  ].join("\n")
}

function isConnectionDefinitionFile(file: string, projectRoot: string, serverDirs: string[] | undefined): boolean {
  const normalized = resolve(file).replace(/\\/g, "/")
  if (/\.connection\.(?:c|m)?[jt]s$/i.test(normalized)) return true
  return (serverDirs ?? [resolve(projectRoot, "server")]).some((directory) => {
    const connectionDirectory = `${resolve(directory, "connections").replace(/\\/g, "/")}/`
    return normalized.startsWith(connectionDirectory) && /\.(?:c|m)?[jt]s$/i.test(normalized)
  })
}

export function hubConnections(options: ConnectionsVitePluginOptions = {}): ConnectionsVitePlugin {
  const importBase = options.importBase ?? "@vite-hub/connections"
  const database = options.database ?? false
  let resolved: ResolvedConfig | undefined
  let definitions: DiscoveredConnectionDefinition[] = []
  let serverDirs: string[] | undefined
  let projectRoot = process.cwd()
  let nitroRegistryFile: string | undefined

  function refresh(): DiscoveredConnectionDefinition[] {
    projectRoot = resolveViteHubProjectRoot(resolve(resolved?.root ?? process.cwd()), { projectRoot: options.projectRoot })
    definitions = discoverConnectionDefinitions({ rootDir: projectRoot, serverDirs })
    return definitions
  }

  async function refreshGeneratedFiles(): Promise<void> {
    await Promise.all([
      writeFileIfChanged(resolve(projectRoot, ".vitehub", "types", "connections.d.ts"), renderRegistryTypes(definitions)),
      ...(nitroRegistryFile ? [writeFileIfChanged(nitroRegistryFile, renderRegistry(definitions, database))] : []),
    ])
  }

  return {
    name: CONNECTIONS_VITE_PLUGIN_NAME,
    enforce: "pre",
    api: {
      getDefinitions: () => definitions,
      refresh,
    },
    vitehub: {
      cli: async () => {
        const { createConnectionsCliContributor } = await import("./cli.ts")
        return createConnectionsCliContributor()
      },
    },
    async config(config, environment) {
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      const nextConfig: Record<string, unknown> = {
        ssr: { noExternal: mergeNoExternal(config.ssr?.noExternal) },
      }
      if (!hasNitroConfigContext(config)) return nextConfig

      const root = resolveViteHubProjectRoot(resolve(config.root || process.cwd()), { projectRoot: options.projectRoot })
      const generatedDir = resolve(root, ".vitehub", "nitro", "connections")
      nitroRegistryFile = resolve(generatedDir, "registry.ts")
      const handlerFile = resolve(generatedDir, "handler.ts")
      await writeFileIfChanged(nitroRegistryFile, renderRegistry(discoverConnectionDefinitions({ rootDir: root, serverDirs }), database))

      const nitro = { ...(config as { nitro?: Record<string, unknown> }).nitro }
      const alias = nitro.alias && typeof nitro.alias === "object" ? nitro.alias as Record<string, unknown> : {}
      const externals = nitro.externals && typeof nitro.externals === "object" ? nitro.externals as Record<string, unknown> : {}
      const inline = externals.inline === true
        ? true
        : [...new Set([...(Array.isArray(externals.inline) ? externals.inline : []), "vite-hub", "@vite-hub/connections"])]
      nitro.alias = { ...alias, [CONNECTIONS_REGISTRY_ID]: nitroRegistryFile }
      nitro.externals = { ...externals, inline }

      if (environment.command === "serve" || options.management) {
        // SAFETY: Nitro baseURL is a normalized mount string when provided by the Nitro config boundary.
        await writeFileIfChanged(handlerFile, renderHandler(importBase, options.actor, `${((nitro.baseURL as string | undefined) ?? "/").replace(/\/+$/, "")}/_vitehub/connections`))
        const kit = createNitroServerKit(nitro)
        // Mount only the API routes. Other requests, such as `GET /_vitehub/connections`, reach the Console page.
        kit.addHandler({ handler: handlerFile, method: "post", route: "/_vitehub/connections" })
        kit.addHandler({ handler: handlerFile, method: "get", route: "/_vitehub/connections/connect/**" })
        kit.addHandler({ handler: handlerFile, method: "get", route: "/_vitehub/connections/callback" })
        Object.assign(nitro, kit.config)
      }
      nextConfig.nitro = nitro
      return nextConfig
    },
    async configResolved(config) {
      resolved = config
      refresh()
      await refreshGeneratedFiles()
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    async handleHotUpdate(context) {
      if (!isConnectionDefinitionFile(context.file, projectRoot, serverDirs)) return
      resolved = context.server.config
      refresh()
      await refreshGeneratedFiles()
      const module = context.server.moduleGraph.getModuleById(resolvedConnectionsRegistryId)
      if (module) context.server.moduleGraph.invalidateModule(module)
    },
    resolveId(id) {
      if (id === CONNECTIONS_REGISTRY_ID) return resolvedConnectionsRegistryId
    },
    load(id) {
      if (id === resolvedConnectionsRegistryId) return renderRegistry(definitions, database)
    },
  }
}
