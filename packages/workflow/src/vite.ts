import { resolveViteHubBundleDefines } from "@vite-hub/internal/build/esbuild"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { resolve } from "node:path"

import { getViteMode } from "@vite-hub/internal/build/mode"
import { encodeProviderOutputAliases } from "@vite-hub/internal/build/esbuild"
import { contributeProviderDeploymentOutput, createProviderDeploymentOutputGenerationState, finalizeProviderDeploymentOutputs, getProviderRuntimeModule, shouldSkipViteProviderBuild, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { removeProviderOutputArtifactDir, retainProviderOutputAliases, retainProviderOutputSources } from "@vite-hub/internal/build/provider-output-sources"
import { collectViteHubProviderImportAliases, createNoExternalAddition, isServerEnvironment, resolveNitroVercelFunctionName, resolveViteHubProjectRoot, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { normalizeHosting } from "@vite-hub/internal/hosting"

import { normalizeWorkflowOptions } from "./config.ts"
import { createCloudflareWorkflowNitroConfig, createOptionalViteDevtoolsPlugin, createVercelWorkflowTransformPlugin, discoverWorkflowProviderSources, generateWorkflowProviderOutputs, hasVercelNativeWorkflowEntry, resolveVercelWorkflowWorld, workflowPackageName, writeProviderEntries } from "./internal/vite-build.ts"

import type { WorkflowModuleOptions } from "./types.ts"
import type { ProviderDeploymentOutputGeneration, ProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import type { Plugin as EsbuildPlugin } from "esbuild"
import type { ViteHubProviderImportContributor } from "@vite-hub/internal/build/vite"
import type { Plugin, ResolvedConfig } from "vite"
import { workflowErrorDiagnostics } from "./error-diagnostics.ts"

export { discoverWorkflowDefinitions } from "./discovery.ts"

interface WorkflowNitroConfigOptions {
  nitro: Record<string, unknown>
  projectRoot: string
  serverDirs?: string[]
  transformRegistry?: (code: string, id: string) => string | Promise<string>
}

export type WorkflowVitePlugin = Plugin & {
  vitehub?: {
    workflow?: {
      createNitroConfig?: (options: WorkflowNitroConfigOptions) => Promise<Record<string, unknown>>
      prepareScheduleRuntime?: (artifactDir?: string, config?: ResolvedConfig) => Promise<{
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

const noExternalAddition = createNoExternalAddition(workflowPackageName)

interface ScheduledWorkflowBuildConfig {
  config: ResolvedConfig
  providerOutput: ProviderOutputCatalog | undefined
  workflow: WorkflowModuleOptions | undefined
  serverDirs: string[] | undefined
}

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
  let resolved: ResolvedConfig | undefined
  const defaultWorkflow: WorkflowModuleOptions | undefined = internalOptions.implicitlyEnabled
    && normalizeHosting(internalOptions.hosting).includes("netlify")
    ? false
    : options
  let workflow = defaultWorkflow
  const scheduleBuildConfigs = new WeakMap<ResolvedConfig, {
    config: ResolvedConfig
    providerOutput: ProviderOutputCatalog | undefined
    workflow: WorkflowModuleOptions | undefined
    serverDirs: string[] | undefined
  }>()
  const scheduledBuildConfigsByRoot = new Map<string, ScheduledWorkflowBuildConfig[]>()
  const buildConfigs = new WeakMap<object, {
    config: ResolvedConfig
    providerOutput: ProviderOutputCatalog | undefined
    serverDirs: string[] | undefined
    workflow: WorkflowModuleOptions | undefined
  }>()
  let serverDirs: string[] | undefined
  const stagedArtifactDirs = new WeakMap<object, string>()
  const fallbackEnvironment = {}
  const buildEnvironment = (context: { environment?: object } | undefined): object =>
    context?.environment ?? context ?? fallbackEnvironment
  const shouldSkipProviderOutputEnvironment = (context: { environment?: { name?: string, config?: ResolvedConfig } } | undefined): boolean => {
    const environmentName = context?.environment?.name
    const config = context?.environment?.config ?? resolved
    const viteHubNitroContext = config && Reflect.get(config, VITEHUB_NITRO_CONFIG_CONTEXT) === true
    const ownerEnvironment = config?.environments?.nitro ? "nitro" : "ssr"
    return Boolean(environmentName && environmentName !== ownerEnvironment && viteHubNitroContext)
  }

  function scheduledBuildConfig(config: ResolvedConfig): ScheduledWorkflowBuildConfig | undefined {
    const direct = scheduleBuildConfigs.get(config)
    if (direct) return direct
    const candidates = scheduledBuildConfigsByRoot.get(config.root) ?? []
    if (candidates.length === 1) return candidates[0]
    const publicDefine = JSON.stringify({ publicUrl: config.define?.__VITEHUB_PUBLIC_URL__, base: config.define?.__VITEHUB_APP_BASE_URL__ })
    return candidates.find(candidate => candidate.config.build.outDir === config.build.outDir
      && JSON.stringify({ publicUrl: candidate.config.define?.__VITEHUB_PUBLIC_URL__, base: candidate.config.define?.__VITEHUB_APP_BASE_URL__ }) === publicDefine)
  }

  function providerRuntimeImportAliases(provider: "cloudflare" | "vercel", generation?: ProviderDeploymentOutputGeneration, catalog = providerOutput): Record<string, string> {
    const database = getProviderRuntimeModule(catalog, "database", provider, generation)
    return database ? { "@vite-hub/database/drizzle": database } : {}
  }

  async function providerImportAliases(config = resolved): Promise<Record<string, string>> {
    if (!config) return { ...internalOptions?.providerImportAliases }
    const contributedAliases = await collectViteHubProviderImportAliases(config.plugins as Array<Plugin & ViteHubProviderImportContributor>)
    return {
      ...resolveStringAliases(config),
      ...contributedAliases,
      ...internalOptions?.providerImportAliases,
    }
  }

  async function prepareScheduleRuntime(artifactDir?: string, config = resolved) {
    if (!config) throw workflowErrorDiagnostics.WORKFLOW_B0001({ message: "[vitehub] Workflow runtime preparation requires resolved Vite config." })
    const build = scheduleBuildConfigs.get(config)
    const workflowOptions = config.workflow ?? build?.workflow ?? defaultWorkflow
    if (normalizeWorkflowOptions(workflowOptions, { hosting: internalOptions?.hosting ?? "vercel" })?.provider !== "vercel") return
    const rootDir = resolveViteHubProjectRoot(config.root)
    const aliases = await providerImportAliases(config)
    // SAFETY: The framework adds optional forwarded server directories to the active Vite configuration.
    const workflowServerDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? build?.serverDirs
    const providerSources = discoverWorkflowProviderSources(config.root, workflowServerDirs)
    const retainedSources = artifactDir
      ? await retainProviderOutputSources({
          artifactDir: resolve(artifactDir, "sources"),
          paths: [
            ...Object.keys(aliases),
            ...Object.values(aliases),
            ...providerSources.paths,
          ],
          roots: [config.root],
        })
      : undefined
    const definitionRootDir = retainedSources?.resolve(config.root) ?? config.root
    const retainedServerDirs = workflowServerDirs?.map(directory => retainedSources?.resolve(directory) ?? directory)
    const retainedAgentInstructions = new Map([...providerSources.agentInstructions]
      .map(([handler, instructions]) => [retainedSources?.resolve(handler) ?? handler, instructions]))
    const artifacts = await writeProviderEntries(rootDir, workflowOptions, {
      agent: internalOptions?.agentImportBase,
      workflow: internalOptions?.importBase,
      workspace: internalOptions?.workspaceImportBase,
      workspaceDependencies: internalOptions?.workspaceDependencyRuntimeImports,
    }, retainedServerDirs, internalOptions?.includeUserAppEntry, (config.plugins as AgentWorkflowRegistryPlugin[])
      .find(plugin => plugin.vitehub?.agent?.transformWorkflowRegistry)
      ?.vitehub?.agent?.transformWorkflowRegistry, definitionRootDir, artifactDir ? resolve(artifactDir, "output") : undefined, retainedAgentInstructions)
    const importBase = internalOptions?.importBase ?? workflowPackageName
    const projectRequire = createRequire(resolve(config.root, "package.json"))
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

  return {
    name: "@vite-hub/workflow/vite",
    config(config) {
      workflow = config.workflow ?? defaultWorkflow
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS]
      // Keep the fallback on each input config so reused plugins do not share forwarded directories.
      // SAFETY: This private fallback field is written by this plugin before Vite resolves the config.
      const buildConfig = config as typeof config & { __vitehubWorkflowServerDirs?: string[] }
      buildConfig.__vitehubWorkflowServerDirs = serverDirs
    },
    configResolved(config) {
      resolved = config
      providerOutput = useProviderOutputCatalog(config)
      workflow = config.workflow ?? defaultWorkflow
      // SAFETY: The framework adds optional forwarded server directories to resolved Vite configuration.
      const buildConfig = config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[], __vitehubWorkflowServerDirs?: string[] }
      const buildServerDirs = buildConfig[VITEHUB_SERVER_DIRS] ?? buildConfig.__vitehubWorkflowServerDirs
      serverDirs = buildServerDirs
      const scheduled = { config, providerOutput, workflow, serverDirs: buildServerDirs }
      scheduleBuildConfigs.set(config, scheduled)
      const configs = scheduledBuildConfigsByRoot.get(config.root) ?? []
      configs.push(scheduled)
      scheduledBuildConfigsByRoot.set(config.root, configs)
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }
      return {
        resolve: { noExternal: noExternalAddition(config.resolve?.noExternal) },
      }
    },
    vitehub: {
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
      const context = buildEnvironment(this)
      // Vite's builder can resolve several environments before starting any of
      // them. Read the environment config here so a reused plugin does not use
      // the last configResolved call for every build.
      const environmentConfig = this?.environment?.config
      if (environmentConfig) {
        // SAFETY: This private fallback field is copied from the plugin's config hook by Vite.
        const config = environmentConfig as typeof environmentConfig & { [VITEHUB_SERVER_DIRS]?: string[], __vitehubWorkflowServerDirs?: string[] }
        const scheduled = scheduledBuildConfig(config) ?? {
          config,
          providerOutput: useProviderOutputCatalog(config),
          serverDirs: config[VITEHUB_SERVER_DIRS] ?? config.__vitehubWorkflowServerDirs,
          workflow: config.workflow ?? defaultWorkflow,
        }
        buildConfigs.set(context, {
          config: environmentConfig,
          providerOutput: scheduled.providerOutput,
          serverDirs: scheduled.serverDirs,
          workflow: scheduled.workflow,
        })
      }
      else if (resolved) {
        buildConfigs.set(context, { config: resolved, providerOutput, serverDirs, workflow })
      }
      providerOutputGenerations.capture(this, buildConfigs.get(context)?.providerOutput ?? providerOutput)
    },
    async buildEnd(error) {
      if (shouldSkipProviderOutputEnvironment(this)) return
      const build = buildConfigs.get(buildEnvironment(this))
      if (error) {
        await providerOutputGenerations.reset(this, build?.providerOutput ?? providerOutput, error)
        return
      }
      const config = build?.config ?? resolved
      const buildProviderOutput = build?.providerOutput ?? providerOutput
      if (!config || shouldSkipViteProviderBuild(config.command, getViteMode())) {
        return
      }
      const rootDir = resolveViteHubProjectRoot(config.root)
      // SAFETY: Vite plugin objects may expose ViteHub's optional agent extension, which the predicate reads defensively.
      const plugins = config.plugins as AgentWorkflowRegistryPlugin[]
      const generation = providerOutputGenerations.get(this)
      const environment = generation ?? buildEnvironment(this)
      const artifactDir = resolve(rootDir, ".vitehub/workflow-generations", randomUUID())
      const workflowOptions = build ? build.workflow : workflow
      const workflowServerDirs = build ? build.serverDirs : serverDirs
      const transformRegistry = plugins
        .find(plugin => plugin.vitehub?.agent?.transformWorkflowRegistry)
        ?.vitehub?.agent?.transformWorkflowRegistry
      try {
        const importAliases = await providerImportAliases(config)
        const runtimeImportAliases = {
          cloudflare: providerRuntimeImportAliases("cloudflare", generation, buildProviderOutput),
          vercel: providerRuntimeImportAliases("vercel", generation, buildProviderOutput),
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
        contributeProviderDeploymentOutput(buildProviderOutput, {
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
              bundleDefines: resolveViteHubBundleDefines(config),
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
        await providerOutputGenerations.reset(this, buildProviderOutput, error)
        throw error
      }
    },
    async renderError(error) {
      if (shouldSkipProviderOutputEnvironment(this)) return
      const environment = providerOutputGenerations.get(this) ?? buildEnvironment(this)
      const build = buildConfigs.get(buildEnvironment(this))
      await providerOutputGenerations.reset(this, build?.providerOutput ?? providerOutput, error)
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
        const build = buildConfigs.get(buildEnvironment(this))
        const config = build?.config ?? resolved
        if (!config || shouldSkipViteProviderBuild(config.command, getViteMode())) return
        await finalizeProviderDeploymentOutputs(build?.providerOutput ?? providerOutput)
      },
    },
  }
}

declare module "vite" {
  interface UserConfig {
    workflow?: WorkflowModuleOptions
  }
}
