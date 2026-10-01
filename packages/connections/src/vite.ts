import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path";

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
// Keep prior output ownership with the project so cleanup works after a restart.
const generatedTypesManifest = ".vitehub/connections-types.json";
const generatedTypesPath = ".vitehub/types/connections.d.ts";
const generatedTypesManifestLock = ".vitehub/connections-types.json.lock";
const staleManifestLockMs = 30_000;
const generatedTypesManifestEntrySchema = v.object({
  root: v.string(),
  hash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  owner: v.optional(v.object({
    pid: v.pipe(v.number(), v.integer(), v.minValue(1)),
    session: v.string(),
  })),
});
const generatedTypesManifestSchema = v.array(generatedTypesManifestEntrySchema);

async function removeLegacyDefaultTypes(root: string): Promise<void> {
  const file = resolve(root, generatedTypesPath);
  const content = await readOptionalFile(file);
  if (content !== undefined && /^declare global \{\n  interface ViteHubConnectionDefinitionModules \{\n(?:    "[^\n]+": typeof import\("[^\n]+"\)\n)*  \}\n\}\n\nexport \{\}\n$/.test(content) && (await lstat(file)).isFile()) {
    await rm(file, { force: true });
  }
}

function typeHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readOptionalFile(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function withManifestLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  await mkdir(resolve(root, ".vitehub"), { recursive: true });
  const lockPath = resolve(root, generatedTypesManifestLock);
  const token = randomUUID();
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (await removeAbandonedManifestLock(lockPath)) continue;
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
  }

  try {
    await writeFile(resolve(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token }));
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }
  const lockIdentity = await lstat(lockPath);

  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(lockPath, now, now).catch(() => undefined);
  }, staleManifestLockMs / 2);
  heartbeat.unref?.();
  try {
    return await action();
  } finally {
    clearInterval(heartbeat);
    try {
      const current = await lstat(lockPath);
      const owner = await readOptionalFile(resolve(lockPath, "owner.json"));
      if (
        current.dev === lockIdentity.dev &&
        current.ino === lockIdentity.ino &&
        owner === JSON.stringify({ pid: process.pid, token })
      ) {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}

async function removeAbandonedManifestLock(lockPath: string): Promise<boolean> {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
  if (Date.now() - lockStat.mtimeMs <= staleManifestLockMs) return false;

  const abandonedPath = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, abandonedPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
  await rm(abandonedPath, { recursive: true, force: true });
  return true;
}

async function readManifest(root: string) {
  const content = await readOptionalFile(resolve(root, generatedTypesManifest));
  if (content === undefined) return [];
  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
  const parsed = v.safeParse(generatedTypesManifestSchema, Array.isArray(input) ? input : [input]);
  return parsed.success ? parsed.output : undefined;
}

type GeneratedTypesEntry = v.InferOutput<typeof generatedTypesManifestEntrySchema>;

async function writeManifest(root: string, entries: GeneratedTypesEntry[]): Promise<void> {
  const manifest = resolve(root, generatedTypesManifest);
  const temporary = `${manifest}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(entries));
    await rename(temporary, manifest);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isOtherProcessActive(entry: GeneratedTypesEntry): boolean {
  if (!entry.owner || entry.owner.pid === process.pid) return false;
  try {
    process.kill(entry.owner.pid, 0);
    return true;
  } catch (error) {
    // Only a confirmed exit allows cleanup. Permission failures preserve ownership.
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

async function removeTrackedTypes(root: string): Promise<void> {
  const entries = await readManifest(root);
  if (!entries) return;
  const activeRoots = new Set(entries.filter(isOtherProcessActive).map(entry => resolve(root, entry.root)));
  const retained: GeneratedTypesEntry[] = [];
  for (const entry of entries) {
    const trackedRoot = resolve(root, entry.root);
    if (activeRoots.has(trackedRoot)) {
      retained.push(entry);
      continue;
    }
    const file = resolve(trackedRoot, generatedTypesPath);
    const previous = await readOptionalFile(file);
    if (previous !== undefined && typeHash(previous) === entry.hash && (await lstat(file)).isFile()) {
      await rm(file, { force: true });
    }
  }
  if (retained.length) await writeManifest(root, retained);
  else await rm(resolve(root, generatedTypesManifest), { force: true });
}

async function recordGeneratedTypes(root: string, projectRoot: string, hash: string, session: string): Promise<void> {
  const entries = await readManifest(root) ?? [];
  // Same-volume roots remain portable; cross-volume Windows roots must stay absolute.
  const relativeRoot = relative(root, projectRoot);
  const storedRoot = isAbsolute(relativeRoot) ? projectRoot : relativeRoot;
  await writeManifest(root, [
    ...entries.filter(entry => !(resolve(root, entry.root) === projectRoot && entry.owner?.session === session)),
    { root: storedRoot, hash, owner: { pid: process.pid, session } },
  ]);
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
    "// Generated by @vite-hub/connections. Do not edit.",
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
  const generationSession = randomUUID();
  let nitroRegistryFile: string | undefined;

  function refresh(): DiscoveredConnectionDefinition[] {
    defaultProjectRoot = resolveViteHubProjectRoot(resolve(resolved?.root ?? process.cwd()))
    projectRoot = resolveViteHubProjectRoot(resolve(resolved?.root ?? process.cwd()), { projectRoot: options.projectRoot });
    definitions = discoverConnectionDefinitions({ rootDir: projectRoot, serverDirs });
    return definitions;
  }

  async function refreshGeneratedFiles(): Promise<void> {
    await withManifestLock(defaultProjectRoot, async () => {
      if (projectRoot !== defaultProjectRoot) await removeLegacyDefaultTypes(defaultProjectRoot);
      await Promise.all([
        writeFileIfChanged(resolve(projectRoot, generatedTypesPath), renderRegistryTypes(definitions)),
        ...(nitroRegistryFile ? [writeFileIfChanged(nitroRegistryFile, renderRegistry(definitions, database))] : []),
      ]);
      await recordGeneratedTypes(defaultProjectRoot, projectRoot, typeHash(renderRegistryTypes(definitions)), generationSession);
    });
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
    await withManifestLock(root, async () => {
      const tracked = await readOptionalFile(resolve(root, generatedTypesManifest));
      await removeTrackedTypes(root);
      if (tracked === undefined) await removeLegacyDefaultTypes(root);
    });
  }
  return {
    name: "@vite-hub/connections/types-cleanup",
    enforce: "pre",
    api: { prepareTypes },
    config: config => prepareTypes({ projectRoot: resolve(config.root || process.cwd()) }),
    configResolved: config => prepareTypes({ projectRoot: config.root }),
  }
}
