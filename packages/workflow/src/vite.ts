import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { resolve } from "node:path"

import { getViteMode } from "@vite-hub/internal/build/mode"
import { encodeProviderOutputAliases } from "@vite-hub/internal/build/esbuild"
import { contributeProviderDeploymentOutput, createProviderDeploymentOutputGenerationState, finalizeProviderDeploymentOutputs, getProviderRuntimeModule, shouldSkipViteProviderBuild, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { removeProviderOutputArtifactDir, retainProviderOutputAliases, retainProviderOutputSources } from "@vite-hub/internal/build/provider-output-sources"
import { collectViteHubProviderImportAliases, createNoExternalAddition, isServerEnvironment, resolveNitroVercelFunctionName, resolveViteHubProjectRoot, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { normalizeHosting } from "@vite-hub/internal/hosting"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import { normalizeWorkflowOptions } from "./config.ts"
import { registerWorkflowDevEndpoint } from "./dev-endpoint.ts"
import { workflowDevRuntimeRoute } from "./dev-support.ts"
import { inspectWorkflowDefinitions } from "./inspect.ts"
import { discoverWorkflowDevDefinitions, workflowDevGeneratedDir, writeWorkflowDevRegistryFiles } from "./internal/dev-registry.ts"
import { writeWorkflowDevFiles } from "./internal/dev-runtime.ts"
import { createCloudflareWorkflowNitroConfig, createOptionalViteDevtoolsPlugin, createVercelWorkflowTransformPlugin, discoverWorkflowProviderSources, generateWorkflowProviderOutputs, hasVercelNativeWorkflowEntry, resolveVercelWorkflowWorld, workflowPackageName, writeProviderEntries } from "./internal/vite-build.ts"

import type { WorkflowDevGeneratedState } from "./internal/dev-runtime.ts"
import type { WorkflowModuleOptions } from "./types.ts"
import type { ProviderDeploymentOutputGeneration, ProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import type { Plugin as EsbuildPlugin } from "esbuild"
import type { ViteHubProviderImportContributor } from "@vite-hub/internal/build/vite"
import type { ViteHubCliPluginMetadata } from "@vite-hub/internal/cli"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { Plugin, ResolvedConfig } from "vite"
import { workflowErrorDiagnostics } from "./error-diagnostics.ts"

export { discoverWorkflowDefinitions } from "./discovery.ts"
export { inspectWorkflowDefinitions, type WorkflowInspectionOptions, workflowConsoleSection } from "./inspect.ts"

interface WorkflowNitroConfigOptions {
  nitro: Record<string, unknown>
  projectRoot: string
  serverDirs?: string[]
  transformRegistry?: (code: string, id: string) => string | Promise<string>
}

export type WorkflowVitePlugin = Plugin & {
  vitehub?: ViteHubInspectionPluginMetadata & ViteHubCliPluginMetadata & {
    workflow?: {
      createNitroConfig?: (options: WorkflowNitroConfigOptions) => Promise<Record<string, unknown>>
      prepareScheduleRuntime?: (artifactDir?: string) => Promise<{
        bundleAlias: Record<string, string>
        bundlePlugins?: EsbuildPlugin[]
        importBase: string
        native: boolean
        registryFile: string
      } | undefined>
    }
  }
}

interface AgentWorkflowRegistryPlugin extends Plugin {
  vitehub?: {
    agent?: {
      transformWorkflowRegistry?: (code: string, id: string) => string | Promise<string>
    }
  }
}

const mergeNoExternal = createNoExternalAddition(workflowPackageName)

interface InternalWorkflowModuleOptions {
  agentImportBase?: string
  hosting?: string
  implicitlyEnabled?: boolean
  importBase?: string
  providerImportAliases?: Record<string, string>
  includeUserAppEntry?: boolean
  workspaceDependencyRuntimeImports?: {
    sandbox?: string
    sandboxRuntimeState?: string
    shellWorkspace?: string
  }
  workspaceImportBase?: string
}

function resolveStringAliases(config: ResolvedConfig): Record<string, string> {
  return encodeProviderOutputAliases(config.resolve.alias)
}

export function hubWorkflow(options?: WorkflowModuleOptions, internalOptions: InternalWorkflowModuleOptions = {}): WorkflowVitePlugin {
  let providerOutput: ProviderOutputCatalog | undefined
  const providerOutputGenerations = createProviderDeploymentOutputGenerationState()
  let hasFinalNitroEnvironment = false
  let resolved: ResolvedConfig | undefined
  let workflow: WorkflowModuleOptions | undefined = internalOptions.implicitlyEnabled
    && normalizeHosting(internalOptions.hosting).includes("netlify")
    ? false
    : options
  let serverDirs: string[] | undefined
  const stagedArtifactDirs = new WeakMap<object, string>()
  const fallbackEnvironment = {}
  const buildEnvironment = (context: { environment?: object } | undefined): object =>
    context?.environment ?? context ?? fallbackEnvironment
  const shouldSkipProviderOutputEnvironment = (context: { environment?: { name?: string } } | undefined): boolean => {
    const environmentName = context?.environment?.name
    const viteHubNitroContext = resolved && Reflect.get(resolved, VITEHUB_NITRO_CONFIG_CONTEXT) === true
    const ownerEnvironment = hasFinalNitroEnvironment ? "nitro" : "ssr"
    return Boolean(environmentName && environmentName !== ownerEnvironment && viteHubNitroContext)
  }

  function providerRuntimeImportAliases(provider: "cloudflare" | "vercel", generation?: ProviderDeploymentOutputGeneration): Record<string, string> {
    const database = getProviderRuntimeModule(providerOutput, "database", provider, generation)
    return database ? { "@vite-hub/database/drizzle": database } : {}
  }

  async function providerImportAliases(): Promise<Record<string, string>> {
    if (!resolved) return { ...internalOptions?.providerImportAliases }
    const contributedAliases = await collectViteHubProviderImportAliases(resolved.plugins as Array<Plugin & ViteHubProviderImportContributor>)
    return {
      ...resolveStringAliases(resolved),
      ...contributedAliases,
      ...internalOptions?.providerImportAliases,
    }
  }

  async function prepareScheduleRuntime(artifactDir?: string) {
    if (!resolved) throw workflowErrorDiagnostics.WORKFLOW_B0001({ message: "[vitehub] Workflow runtime preparation requires resolved Vite config." })
    if (normalizeWorkflowOptions(workflow, { hosting: internalOptions?.hosting ?? "vercel" })?.provider !== "vercel") return
    const rootDir = resolveViteHubProjectRoot(resolved.root)
    const aliases = await providerImportAliases()
    const providerSources = discoverWorkflowProviderSources(resolved.root, serverDirs)
    const retainedSources = artifactDir
      ? await retainProviderOutputSources({
          artifactDir: resolve(artifactDir, "sources"),
          paths: [
            ...Object.keys(aliases),
            ...Object.values(aliases),
            ...providerSources.paths,
          ],
          roots: [resolved.root],
        })
      : undefined
    const definitionRootDir = retainedSources?.resolve(resolved.root) ?? resolved.root
    const retainedServerDirs = serverDirs?.map(directory => retainedSources?.resolve(directory) ?? directory)
    const retainedAgentInstructions = new Map([...providerSources.agentInstructions]
      .map(([handler, instructions]) => [retainedSources?.resolve(handler) ?? handler, instructions]))
    const artifacts = await writeProviderEntries(rootDir, workflow, {
      agent: internalOptions?.agentImportBase,
      workflow: internalOptions?.importBase,
      workspace: internalOptions?.workspaceImportBase,
      workspaceDependencies: internalOptions?.workspaceDependencyRuntimeImports,
    }, retainedServerDirs, internalOptions?.includeUserAppEntry, (resolved.plugins as AgentWorkflowRegistryPlugin[])
      .find(plugin => plugin.vitehub?.agent?.transformWorkflowRegistry)
      ?.vitehub?.agent?.transformWorkflowRegistry, definitionRootDir, artifactDir ? resolve(artifactDir, "output") : undefined, retainedAgentInstructions)
    const importBase = internalOptions?.importBase ?? workflowPackageName
    const projectRequire = createRequire(resolve(resolved.root, "package.json"))
    const retainedAliases = retainedSources ? retainProviderOutputAliases(aliases, retainedSources) : aliases
    const native = hasVercelNativeWorkflowEntry(rootDir, artifacts.providerDefinitions, retainedAliases, artifacts.vercelNativeFiles)
    const workflowRequire = native ? createRequire(import.meta.url) : undefined
    const workflowApi = workflowRequire?.resolve("workflow/api")
    return {
      bundleAlias: {
        ...retainedAliases,
        [`${importBase}/runtime/state`]: projectRequire.resolve(`${importBase}/runtime/state`),
        [`${importBase}/runtime/vercel-vite`]: projectRequire.resolve(`${importBase}/runtime/vercel-vite`),
        ...(workflowApi && workflowRequire
          ? {
              "@workflow/core/runtime/world-target": resolveVercelWorkflowWorld(workflowApi),
              "workflow/api": workflowApi,
              "workflow/runtime": workflowRequire.resolve("workflow/runtime"),
            }
          : {}),
      },
      bundlePlugins: [
        createOptionalViteDevtoolsPlugin(rootDir),
        ...(native ? [await createVercelWorkflowTransformPlugin(rootDir)] : []),
      ].filter((plugin): plugin is EsbuildPlugin => Boolean(plugin)),
      importBase,
      native,
      registryFile: artifacts.registryFile,
    }
  }

  // Provider servers install the discovered Workflow registry in production.
  // In `vite dev`, a generated Nitro plugin installs it in the Nitro dev
  // runtime. `vitehub workflow` runs its operations in the same runtime
  // through a development-only Nitro handler, and only reads that registry.
  let devRegistryRootDir: string | undefined

  function devGeneratedState(): WorkflowDevGeneratedState {
    try {
      const config = normalizeWorkflowOptions(workflow, { hosting: internalOptions.hosting ?? "vercel" })
      return { configuredProvider: config ? config.provider : null }
    }
    catch (error) {
      return { configError: error instanceof Error ? error.message : String(error), configuredProvider: null }
    }
  }

  async function writeDevRegistry(rootDir: string) {
    return await writeWorkflowDevRegistryFiles({
      definitions: discoverWorkflowDevDefinitions(rootDir, serverDirs),
      importBase: internalOptions.importBase,
      projectRoot: resolveViteHubProjectRoot(rootDir),
      workflow: normalizeWorkflowOptions(workflow, { hosting: internalOptions.hosting ?? "vercel" }) ?? false,
    })
  }

  return {
    name: "@vite-hub/workflow/vite",
    config: {
      // Nitro reads `config.nitro` in its own `config` hook, so the plugin and the dev handler must be added first.
      order: "pre",
      async handler(config, env) {
        workflow = config.workflow ?? workflow
        // SAFETY: Vite config permits the shared server-directory symbol added by ViteHub discovery.
        serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
        if (env.command !== "serve") return
        const rootDir = resolve(config.root || process.cwd())
        const state = devGeneratedState()
        // SAFETY: Nitro extends Vite config with an opaque nitro value that the server kit validates.
        const kit = createNitroServerKit((config as { nitro?: unknown }).nitro)
        // The build reports configuration errors. Development keeps the app running without a registry.
        if (state.configuredProvider) {
          devRegistryRootDir = rootDir
          kit.addPlugin((await writeDevRegistry(rootDir)).plugin, "start")
        }
        const { handler } = await writeWorkflowDevFiles({ ...state, importBase: internalOptions.importBase, projectRoot: resolveViteHubProjectRoot(rootDir) })
        kit.addHandler({ handler, route: workflowDevRuntimeRoute })
        // SAFETY: Nitro reads this extension in its later config hook; the server kit owns its value.
        ;(config as { nitro?: unknown }).nitro = kit.config
      },
    },
    configureServer(server) {
      if (resolved?.command === "serve") {
        registerWorkflowDevEndpoint(server, {
          nitroBaseURL: () => {
            // SAFETY: Vite keeps unknown user config keys on the resolved config. Nitro reads the same `nitro` key.
            const baseURL = (resolved as (ResolvedConfig & { nitro?: { baseURL?: unknown } }) | undefined)?.nitro?.baseURL
            // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate the unknown Nitro dev URL from resolved Vite config.
            return typeof baseURL === "string" ? baseURL : process.env.NITRO_APP_BASE_URL
          },
        })
      }
      const rootDir = devRegistryRootDir
      if (!rootDir) return
      // Vite does not call `handleHotUpdate` for new or deleted files, so watch them directly.
      const refresh = async (path: string) => {
        const file = path.replace(/\\/g, "/")
        if (file.includes(`/${workflowDevGeneratedDir}/`)) return
        if (!/\.(?:c|m)?[jt]s$/i.test(file) || !/(?:\/workflows\/|\.workflow\.)/i.test(file)) return
        const { changed } = await writeDevRegistry(rootDir)
        const nitro = server.environments.nitro
        for (const changedFile of changed) {
          for (const module of nitro?.moduleGraph.getModulesByFile(changedFile) ?? []) nitro?.moduleGraph.invalidateModule(module)
        }
      }
      let pendingRefresh = Promise.resolve()
      for (const event of ["add", "change", "unlink"] as const) {
        server.watcher.on(event, path => {
          pendingRefresh = pendingRefresh.then(() => refresh(path)).catch(error => {
            server.config.logger.error(`[vitehub] Workflow dev registry update failed: ${error instanceof Error ? error.message : String(error)}`)
          })
        })
      }
    },
    configResolved(config) {
      resolved = config
      hasFinalNitroEnvironment = Boolean(config.environments?.nitro)
      providerOutput = useProviderOutputCatalog(config)
      workflow = config.workflow ?? workflow
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    vitehub: {
      cli: async () => (await import("./cli.ts")).createWorkflowCliContributor(),
      inspect: () => ({
        definitions: [{
          kind: "workflow",
          label: "Workflows",
          list: () => {
            const rootDir = resolved?.root ?? process.cwd()
            return inspectWorkflowDefinitions({ projectRoot: resolveViteHubProjectRoot(rootDir), rootDir, serverDirs })
          },
        }],
      }),
      workflow: {
        async createNitroConfig({ nitro, projectRoot, serverDirs: nitroServerDirs, transformRegistry }: WorkflowNitroConfigOptions) {
          return await createCloudflareWorkflowNitroConfig({
            agentImportBase: internalOptions?.agentImportBase,
            nitro,
            rootDir: projectRoot,
            serverDirs: nitroServerDirs,
            includeUserAppEntry: internalOptions?.includeUserAppEntry,
            workflow,
            workflowImportBase: internalOptions?.importBase,
            workspaceDependencyRuntimeImports: internalOptions?.workspaceDependencyRuntimeImports,
            workspaceImportBase: internalOptions?.workspaceImportBase,
            transformRegistry,
          })
        },
        prepareScheduleRuntime,
      },
    },
    buildStart() {
      if (shouldSkipProviderOutputEnvironment(this)) return
      providerOutputGenerations.capture(this, providerOutput)
    },
    async buildEnd(error) {
      if (shouldSkipProviderOutputEnvironment(this)) return
      if (error) {
        await providerOutputGenerations.reset(this, providerOutput, error)
        return
      }
      if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) {
        return
      }
      const config = resolved
      const rootDir = resolveViteHubProjectRoot(config.root)
      // SAFETY: Vite plugin objects may expose ViteHub's optional agent extension, which the predicate reads defensively.
      const plugins = config.plugins as AgentWorkflowRegistryPlugin[]
      const generation = providerOutputGenerations.get(this)
      const environment = generation ?? buildEnvironment(this)
      const artifactDir = resolve(rootDir, ".vitehub/workflow-generations", randomUUID())
      const workflowOptions = workflow
      const workflowServerDirs = serverDirs
      const transformRegistry = plugins
        .find(plugin => plugin.vitehub?.agent?.transformWorkflowRegistry)
        ?.vitehub?.agent?.transformWorkflowRegistry
      try {
        const importAliases = await providerImportAliases()
        const runtimeImportAliases = {
          cloudflare: providerRuntimeImportAliases("cloudflare", generation),
          vercel: providerRuntimeImportAliases("vercel", generation),
        }
        const providerSources = discoverWorkflowProviderSources(config.root, workflowServerDirs)
        const retainedSources = await retainProviderOutputSources({
          artifactDir: resolve(artifactDir, "sources"),
          paths: [
            ...Object.keys(importAliases),
            ...Object.values(importAliases),
            ...Object.keys(runtimeImportAliases.cloudflare),
            ...Object.values(runtimeImportAliases.cloudflare),
            ...Object.keys(runtimeImportAliases.vercel),
            ...Object.values(runtimeImportAliases.vercel),
            ...providerSources.paths,
          ],
          roots: [config.root],
        })
        const retainedImportAliases = retainProviderOutputAliases(importAliases, retainedSources)
        const retainedRuntimeImportAliases = {
          cloudflare: retainProviderOutputAliases(runtimeImportAliases.cloudflare, retainedSources),
          vercel: retainProviderOutputAliases(runtimeImportAliases.vercel, retainedSources),
        }
        const retainedDefinitionRoot = retainedSources.resolve(config.root)
        const retainedServerDirs = workflowServerDirs?.map(directory => retainedSources.resolve(directory))
        const retainedAgentInstructions = new Map([...providerSources.agentInstructions]
          .map(([handler, instructions]) => [retainedSources.resolve(handler), instructions]))
        const artifacts = await writeProviderEntries(rootDir, workflowOptions, {
          agent: internalOptions?.agentImportBase,
          workflow: internalOptions?.importBase,
          workspace: internalOptions?.workspaceImportBase,
          workspaceDependencies: internalOptions?.workspaceDependencyRuntimeImports,
        }, retainedServerDirs, internalOptions?.includeUserAppEntry, transformRegistry, retainedDefinitionRoot, resolve(artifactDir, "output"), retainedAgentInstructions)
        stagedArtifactDirs.set(environment, artifactDir)
        contributeProviderDeploymentOutput(providerOutput, {
          discard: async () => {
            await removeProviderOutputArtifactDir(artifactDir)
            if (stagedArtifactDirs.get(environment) === artifactDir) stagedArtifactDirs.delete(environment)
          },
          owner: "workflow",
          rootDir,
          write: async ({ write }) => {
            await generateWorkflowProviderOutputs({
              agentImportBase: internalOptions?.agentImportBase,
              artifacts,
              clientOutDir: resolve(config.root, config.build.outDir),
              hosting: internalOptions?.hosting,
              importBase: internalOptions?.importBase,
              providerImportAliases: retainedImportAliases,
              providerRuntimeImportAliases: retainedRuntimeImportAliases,
              rootDir,
              definitionRootDir: retainedDefinitionRoot,
              serverDirs: retainedServerDirs,
              serverFunctionName: resolveNitroVercelFunctionName(config, "workflow"),
              sourceRootDir: retainedSources.resolve(rootDir),
              includeUserAppEntry: internalOptions?.includeUserAppEntry,
              workflow: workflowOptions,
              workspaceDependencyRuntimeImports: internalOptions?.workspaceDependencyRuntimeImports,
              workspaceImportBase: internalOptions?.workspaceImportBase,
              transformRegistry,
            }, write)
          },
        }, generation)
      }
      catch (error) {
        await removeProviderOutputArtifactDir(artifactDir)
        if (stagedArtifactDirs.get(environment) === artifactDir) stagedArtifactDirs.delete(environment)
        await providerOutputGenerations.reset(this, providerOutput, error)
        throw error
      }
    },
    async renderError(error) {
      if (shouldSkipProviderOutputEnvironment(this)) return
      const environment = providerOutputGenerations.get(this) ?? buildEnvironment(this)
      await providerOutputGenerations.reset(this, providerOutput, error)
      const artifactDir = stagedArtifactDirs.get(environment)
      if (artifactDir) {
        await removeProviderOutputArtifactDir(artifactDir)
        if (stagedArtifactDirs.get(environment) === artifactDir) stagedArtifactDirs.delete(environment)
      }
    },
    closeBundle: {
      order: "post",
      sequential: true,
      async handler() {
        if (shouldSkipProviderOutputEnvironment(this)) return
        if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) return
        await finalizeProviderDeploymentOutputs(providerOutput)
      },
    },
  }
}

declare module "vite" {
  interface UserConfig {
    workflow?: WorkflowModuleOptions
  }
}
