import { readFile, rm } from "node:fs/promises"
import { resolve } from "node:path";

import * as v from "valibot";

import {
  createNoExternalAddition,
  hasNitroConfigContext,
  isServerEnvironment,
  resolveViteHubProjectRoot,
  VITEHUB_SERVER_DIRS,
} from "@vite-hub/internal/build/vite";
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog";
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit";

import { discoverConnectionDefinitions } from "./discovery.ts";

import type { ViteHubCliContributor } from "@vite-hub/internal/cli";
import type { Plugin, ResolvedConfig } from "vite";
import type { DiscoveredConnectionDefinition } from "./types.ts";

export const CONNECTIONS_REGISTRY_ID = "#vitehub/connections/registry";
export const CONNECTIONS_VITE_PLUGIN_NAME = "@vite-hub/connections/vite";

const resolvedConnectionsRegistryId = `\0${CONNECTIONS_REGISTRY_ID}`;
const noExternalAddition = createNoExternalAddition("@vite-hub/connections");
const connectionsTypeRootsFile = (projectRoot: string): string =>
  resolve(projectRoot, ".vitehub", "types", "connections-roots.json");

async function readGeneratedConnectionsTypeRoots(projectRoot: string): Promise<string[]> {
  try {
    const contents = await readFile(connectionsTypeRootsFile(projectRoot), "utf8");
    const roots: unknown = JSON.parse(contents);
    return Array.isArray(roots) && roots.every(root => typeof root === "string") ? roots : [];
  } catch {
    return [];
  }
}

export interface ConnectionsVitePluginOptions {
  /** Module that exports the ViteHub Database as `db`. Set `false` when the app has no database. */
  database?: string | false;
  /** Package that the generated handler imports from. */
  importBase?: string;
  /**
   * Mount the management API in production. The development server always mounts it.
   * Production requires an actor module whose default export authenticates each Request
   * and returns `user:<id>` or `undefined` to deny access.
   */
  management?: boolean | { actor: string };
  projectRoot?: string;
}

export interface ConnectionsVitePluginAPI {
  prepareTypes: (options: { projectRoot: string, serverDirs?: string[] }) => Promise<void>
  getDefinitions: () => DiscoveredConnectionDefinition[];
  refresh: () => DiscoveredConnectionDefinition[];
}

export type ConnectionsVitePlugin = Plugin<ConnectionsVitePluginAPI> & {
  api: ConnectionsVitePluginAPI;
  vitehub: { cli: () => Promise<ViteHubCliContributor> };
};

function renderRegistry(
  definitions: DiscoveredConnectionDefinition[],
  database: string | false,
): string {
  return [
    "const registry = Object.create(null)",
    ...definitions.map(
      (definition) =>
        `registry[${JSON.stringify(definition.name)}] = () => import(${JSON.stringify(definition.handler)})`,
    ),
    "",
    database
      ? `export const database = () => import(${JSON.stringify(database)}).then(module => module.db)`
      : "export const database = undefined",
    "export default registry",
    "",
  ].join("\n");
}

function renderRegistryTypes(definitions: DiscoveredConnectionDefinition[]): string {
  return [
    "declare global {",
    "  interface ViteHubConnectionDefinitionModules {",
    ...definitions.map(
      (definition) =>
        `    ${JSON.stringify(definition.name)}: typeof import(${JSON.stringify(definition.handler)})`,
    ),
    "  }",
    "}",
    "",
    "export {}",
    "",
  ].join("\n");
}

function isConnectionDefinitionFile(
  file: string,
  projectRoot: string,
  serverDirs: string[] | undefined,
): boolean {
  const normalized = resolve(file).replace(/\\/g, "/");
  if (/\.connection\.(?:c|m)?[jt]s$/i.test(normalized)) return true;
  return (serverDirs ?? [resolve(projectRoot, "server")]).some((directory) => {
    const connectionDirectory = `${resolve(directory, "connections").replace(/\\/g, "/")}/`;
    return normalized.startsWith(connectionDirectory) && /\.(?:[jt]sx?|[cm][jt]s)$/i.test(normalized);
  });
}

export function hubConnections(options: ConnectionsVitePluginOptions = {}): ConnectionsVitePlugin {
  const importBase = options.importBase ?? "@vite-hub/connections";
  const database = options.database ?? false;
  let resolved: ResolvedConfig | undefined;
  let definitions: DiscoveredConnectionDefinition[] = [];
  let serverDirs: string[] | undefined;
  let defaultProjectRoot = resolveViteHubProjectRoot(process.cwd())
  let projectRoot = process.cwd();
  let nitroRegistryFile: string | undefined;

  function refresh(): DiscoveredConnectionDefinition[] {
    defaultProjectRoot = resolveViteHubProjectRoot(resolve(resolved?.root ?? process.cwd()))
    projectRoot = resolveViteHubProjectRoot(resolve(resolved?.root ?? process.cwd()), { projectRoot: options.projectRoot });
    definitions = discoverConnectionDefinitions({ rootDir: projectRoot, serverDirs });
    return definitions;
  }

  async function refreshGeneratedFiles(): Promise<void> {
    if (projectRoot !== defaultProjectRoot) await rm(resolve(defaultProjectRoot, ".vitehub/types/connections.d.ts"), { force: true })
    const roots = await readGeneratedConnectionsTypeRoots(defaultProjectRoot);
    if (!roots.includes(projectRoot)) roots.push(projectRoot);
    await Promise.all([
      writeFileIfChanged(
        resolve(projectRoot, ".vitehub", "types", "connections.d.ts"),
        renderRegistryTypes(definitions),
      ),
      writeFileIfChanged(connectionsTypeRootsFile(defaultProjectRoot), `${JSON.stringify(roots)}\n`),
      ...(nitroRegistryFile
        ? [writeFileIfChanged(nitroRegistryFile, renderRegistry(definitions, database))]
        : []),
    ]);
  }

  return {
    name: CONNECTIONS_VITE_PLUGIN_NAME,
    enforce: "pre",
    api: {
      async prepareTypes(input) {
        defaultProjectRoot = resolveViteHubProjectRoot(input.projectRoot)
        projectRoot = resolveViteHubProjectRoot(input.projectRoot, { projectRoot: options.projectRoot })
        serverDirs = input.serverDirs
        definitions = discoverConnectionDefinitions({ rootDir: projectRoot, serverDirs })
        await refreshGeneratedFiles()
      },
      getDefinitions: () => definitions,
      refresh,
    },
    vitehub: {
      cli: async () => {
        const { createConnectionsCliContributor } = await import("./cli.ts");
        return createConnectionsCliContributor();
      },
    },
    async config(config, environment) {
      serverDirs =
        v.parse(v.optional(v.array(v.string())), Reflect.get(config, VITEHUB_SERVER_DIRS)) ??
        serverDirs;
      const nextConfig: Record<string, unknown> = {
        ssr: { noExternal: noExternalAddition(config.ssr?.noExternal) },
      };
      if (!hasNitroConfigContext(config)) return nextConfig;

      const root = resolveViteHubProjectRoot(resolve(config.root || process.cwd()), {
        projectRoot: options.projectRoot,
      });
      const generatedDir = resolve(root, ".vitehub", "nitro", "connections");
      nitroRegistryFile = resolve(generatedDir, "registry.ts");
      const handlerFile = resolve(generatedDir, "handler.ts");
      await writeFileIfChanged(
        nitroRegistryFile,
        renderRegistry(discoverConnectionDefinitions({ rootDir: root, serverDirs }), database),
      );

      const nitroInput: unknown = Reflect.get(config, "nitro");
      const nitro = v.parse(
        v.looseObject({
          alias: v.optional(v.record(v.string(), v.unknown()), {}),
          externals: v.optional(
            v.looseObject({
              inline: v.optional(v.union([v.literal(true), v.array(v.unknown())]), []),
            }),
            {},
          ),
        }),
        nitroInput ?? {},
      );
      const alias = nitro.alias;
      const externals = nitro.externals;
      const inline =
        externals.inline === true
          ? true
          : [
              ...new Set([
                ...(Array.isArray(externals.inline) ? externals.inline : []),
                "vite-hub",
                "@vite-hub/connections",
              ]),
            ];
      nitro.alias = { ...alias, [CONNECTIONS_REGISTRY_ID]: nitroRegistryFile };
      nitro.externals = { ...externals, inline };

      if (environment.command === "serve" || options.management) {
        const actorModule =
          options.management && options.management !== true ? options.management.actor : undefined;
        if (environment.command !== "serve" && !actorModule?.trim()) {
          throw new Error(
            "Connections management in production requires management: { actor: <authentication module> }.",
          );
        }
        const actorImport = actorModule?.startsWith(".") ? resolve(root, actorModule) : actorModule;
        await writeFileIfChanged(
          handlerFile,
          [
            `import { createConnectionsHandler } from ${JSON.stringify(`${importBase}/server`)}`,
            "",
            ...(actorModule ? [`import actor from ${JSON.stringify(actorImport)}`] : []),
            "",
            actorModule
              ? "const handle = createConnectionsHandler({ actor })"
              : 'const handle = createConnectionsHandler({ actor: () => "user:local" })',
            "",
            "export default (event: { req: Request }) => handle(event.req)",
            "",
          ].join("\n"),
        );
        const kit = createNitroServerKit(nitro);
        kit.addHandler({ handler: handlerFile, route: "/_vitehub/connections" });
        kit.addHandler({ handler: handlerFile, route: "/_vitehub/connections/**" });
        Object.assign(nitro, kit.config);
      }
      Reflect.set(config, "nitro", nitro);
      return nextConfig;
    },
    async configResolved(config) {
      resolved = config;
      refresh();
      await refreshGeneratedFiles();
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return;
      return {
        resolve: { noExternal: noExternalAddition(config.resolve?.noExternal) },
      };
    },
    async handleHotUpdate(context) {
      if (!isConnectionDefinitionFile(context.file, projectRoot, serverDirs)) return;
      resolved = context.server.config;
      refresh();
      await refreshGeneratedFiles();
      const module = context.server.moduleGraph.getModuleById(resolvedConnectionsRegistryId);
      if (module) context.server.moduleGraph.invalidateModule(module);
    },
    resolveId(id) {
      if (id === CONNECTIONS_REGISTRY_ID) return resolvedConnectionsRegistryId;
    },
    load(id) {
      if (id === resolvedConnectionsRegistryId) return renderRegistry(definitions, database);
    },
  };
}

/** Remove declarations when a host disables Connections. */
export function hubConnectionsTypesCleanup(): Plugin<{ prepareTypes: (options: { projectRoot: string }) => Promise<void> }> {
  const prepareTypes = async (options: { projectRoot: string }): Promise<void> => {
    const root = resolveViteHubProjectRoot(options.projectRoot)
    const generatedRoots = await readGeneratedConnectionsTypeRoots(root)
    await Promise.all([
      rm(resolve(root, ".vitehub/types/connections.d.ts"), { force: true }),
      rm(connectionsTypeRootsFile(root), { force: true }),
      ...generatedRoots.map(projectRoot =>
        rm(resolve(projectRoot, ".vitehub/types/connections.d.ts"), { force: true }),
      ),
    ])
  }
  return {
    name: "@vite-hub/connections/types-cleanup",
    enforce: "pre",
    api: { prepareTypes },
    config: config => prepareTypes({ projectRoot: resolve(config.root || process.cwd()) }),
    configResolved: config => prepareTypes({ projectRoot: config.root }),
  }
}
