import { resolve } from "node:path"

import { discoverWorkflowDefinitions } from "../discovery.ts"
import { workflowErrorDiagnostics } from "../error-diagnostics.ts"
import { createWorkflowRegistryContents, workflowPackageName } from "./vite-build.ts"

import type { ViteDevServer } from "vite"
import type { WorkflowDevRuntime } from "../dev-endpoint.ts"
import type { DiscoveredWorkflowDefinition, ResolvedWorkflowOptions } from "../types.ts"

// The Workflow dev endpoint runs in the Vite Development Server process. Nitro
// development runs in its own worker, so the endpoint cannot reach Workflow
// state there. It loads the Workflow runtime and a Workflow registry through
// the Vite SSR module graph instead, as the Agent dev endpoint does.
export const workflowDevRuntimeId = "#vitehub/workflow/dev-runtime"
export const resolvedWorkflowDevRuntimeId = `\0${workflowDevRuntimeId}`
export const workflowDevRegistryId = "#vitehub/workflow/dev-registry"
export const resolvedWorkflowDevRegistryId = `\0${workflowDevRegistryId}`

interface WorkflowDevRuntimeModule extends WorkflowDevRuntime {
  installWorkflowDevRuntime: (config: false | ResolvedWorkflowOptions) => void
}

/**
 * Agent Workflows start through Agent invocations, so the Workflow CLI does not start them.
 */
export function isWorkflowDevStartable(definition: DiscoveredWorkflowDefinition): boolean {
  return definition.source !== "agent-workflow" && definition.source !== "agent-workflow-recovery"
}

export function discoverWorkflowDevDefinitions(rootDir: string, serverDirs?: string[]): DiscoveredWorkflowDefinition[] {
  return discoverWorkflowDefinitions({ rootDir, serverDirs }).filter(isWorkflowDevStartable)
}

export function createWorkflowDevRegistryModule(rootDir: string, definitions: DiscoveredWorkflowDefinition[], importBase = workflowPackageName): string {
  return createWorkflowRegistryContents(
    resolve(rootDir, ".vitehub/workflow/dev-registry.mjs"),
    definitions.filter(isWorkflowDevStartable),
    { workflow: importBase },
  )
}

export function createWorkflowDevRuntimeModule(importBase = workflowPackageName): string {
  return [
    `import { setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from ${JSON.stringify(`${importBase}/runtime/state`)}`,
    `import registry from ${JSON.stringify(workflowDevRegistryId)}`,
    "",
    `export { cancelWorkflow, getWorkflowRun, resumeWorkflowSignal, runWorkflow } from ${JSON.stringify(importBase)}`,
    "",
    "export function installWorkflowDevRuntime(config) {",
    "  setWorkflowRuntimeConfig(config)",
    "  setWorkflowRuntimeRegistry(registry)",
    "}",
    "",
  ].join("\n")
}

function isWorkflowDevRuntimeModule(value: Record<string, unknown>): value is Record<string, unknown> & WorkflowDevRuntimeModule {
  return ["cancelWorkflow", "getWorkflowRun", "installWorkflowDevRuntime", "resumeWorkflowSignal", "runWorkflow"]
    .every(name => typeof value[name] === "function")
}

export interface WorkflowDevRuntimeLoaderOptions {
  config: () => false | ResolvedWorkflowOptions
  /** Returns `true` when the served registry module no longer matches the discovered definitions. */
  isRegistryStale: () => boolean
}

/**
 * Loads the Workflow runtime client through the Vite SSR module graph and
 * installs the Workflow configuration and registry once per module instance.
 */
export function createWorkflowDevRuntimeLoader(
  server: Pick<ViteDevServer, "moduleGraph" | "ssrLoadModule">,
  options: WorkflowDevRuntimeLoaderOptions,
): () => Promise<WorkflowDevRuntime> {
  const installed = new WeakSet<object>()
  return async () => {
    if (options.isRegistryStale()) {
      for (const id of [resolvedWorkflowDevRegistryId, resolvedWorkflowDevRuntimeId]) {
        const module = server.moduleGraph.getModuleById(id)
        if (module) server.moduleGraph.invalidateModule(module)
      }
    }
    const module = await server.ssrLoadModule(workflowDevRuntimeId)
    if (!isWorkflowDevRuntimeModule(module)) {
      throw workflowErrorDiagnostics.WORKFLOW_R0031({ message: "[vitehub] The Workflow dev runtime module has no Workflow runtime client." })
    }
    if (!installed.has(module)) {
      module.installWorkflowDevRuntime(options.config())
      installed.add(module)
    }
    return module
  }
}
