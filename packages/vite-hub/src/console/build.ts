import { discoverAgentDefinitionEntries } from "@vite-hub/agent/vite"
import { inspectDatabaseDefinitions } from "@vite-hub/database/vite"
import { inspectQueueDefinitions } from "@vite-hub/queue/vite"
import { inspectRateLimitDefinitions } from "@vite-hub/rate-limit/vite"
import { discoverScheduleDefinitions, inspectScheduleDefinitions } from "@vite-hub/schedule/vite"
import { inspectSandboxDefinitions } from "@vite-hub/sandbox/vite"
import { inspectWorkflowDefinitions } from "@vite-hub/workflow/vite"
import { inspectWorkspaceDefinitions } from "@vite-hub/workspace/vite"

import type { ConsoleDefinitionCatalog } from "./runtime/definitions.ts"
import type { ConsoleSectionId } from "./runtime/sections.ts"

export type ConsoleAgentEntry = { handler: string; name: string }

/** A Static Schedule Definition that sets `manual: true`. */
export type ConsoleScheduleEntry = { handler: string; name: string }

export interface ConsoleBuildCatalog {
  agents: readonly ConsoleAgentEntry[]
  definitions: ConsoleDefinitionCatalog
  manualSchedules?: readonly ConsoleScheduleEntry[]
}

/**
 * Reads Definition summaries from their owner packages. `vitehub inspect definitions` uses the same owner functions,
 * so the Console and the CLI show the same data.
 */
export async function discoverConsoleBuildCatalog(options: {
  databaseDiscoveryRoot?: string
  discoveryRoot: string
  projectRoot: string
  queueDiscoveryRoot?: string
  rateLimitDiscoveryRoot?: string
  rateLimitScanDirs?: string[]
  sandboxDiscoveryRoot?: string
  sections: readonly ConsoleSectionId[]
  scheduleDiscoveryRoot?: string
  serverDirs?: string[]
  workspaceDiscoveryRoot?: string
  workflowDiscoveryRoot?: string
}): Promise<ConsoleBuildCatalog> {
  const { projectRoot, sections, serverDirs } = options
  const agents = sections.includes("agents")
    ? discoverAgentDefinitionEntries(options.discoveryRoot, serverDirs)
    : []
  const definitions: ConsoleDefinitionCatalog = {}
  if (sections.includes("databases")) {
    definitions.databases = inspectDatabaseDefinitions({
      projectRoot,
      rootDir: options.databaseDiscoveryRoot ?? options.discoveryRoot,
      serverDirs: options.databaseDiscoveryRoot ? undefined : serverDirs,
    })
  }
  if (sections.includes("rate-limits")) {
    definitions["rate-limits"] = inspectRateLimitDefinitions({
      projectRoot,
      rootDir: options.rateLimitDiscoveryRoot ?? projectRoot,
      scanDirs: options.rateLimitScanDirs,
    })
  }
  if (sections.includes("sandboxes")) {
    definitions.sandboxes = inspectSandboxDefinitions({ projectRoot, rootDir: options.sandboxDiscoveryRoot ?? projectRoot })
  }
  if (sections.includes("workspaces")) {
    definitions.workspaces = inspectWorkspaceDefinitions({
      projectRoot,
      rootDir: options.discoveryRoot,
      serverDirs,
      serverRootDir: options.workspaceDiscoveryRoot ?? projectRoot,
    })
  }
  if (sections.includes("workflows")) {
    definitions.workflows = inspectWorkflowDefinitions({
      projectRoot,
      rootDir: options.workflowDiscoveryRoot ?? options.discoveryRoot,
      serverDirs,
    })
  }
  if (sections.includes("queues")) {
    definitions.queues = inspectQueueDefinitions({
      projectRoot,
      rootDir: options.queueDiscoveryRoot ?? options.discoveryRoot,
      serverDirs,
    })
  }
  if (sections.includes("schedules")) {
    definitions.schedules = await inspectScheduleDefinitions({
      projectRoot,
      rootDir: options.discoveryRoot,
      serverDirs,
      serverRootDir: options.scheduleDiscoveryRoot ?? projectRoot,
    })
  }
  const manualSchedules = sections.includes("schedules")
    ? discoverScheduleDefinitions({
        rootDir: options.discoveryRoot,
        serverDirs,
        serverRootDir: options.scheduleDiscoveryRoot ?? projectRoot,
      })
        .filter(definition => definition.manual === true && definition.runtimeOnly !== true)
        .map(definition => ({ handler: definition.handler, name: definition.name }))
    : []
  return { agents, definitions, manualSchedules }
}
