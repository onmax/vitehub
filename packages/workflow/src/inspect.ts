import { relativeDefinitionFile } from "@vite-hub/internal/inspect"

import { discoverWorkflowDefinitions } from "./discovery.ts"

import type { ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"
import type { DiscoveredWorkflowDefinition } from "./types.ts"

export interface WorkflowInspectionOptions {
  projectRoot: string
  rootDir: string
  serverDirs?: string[]
}

function summarizeWorkflowDefinition(projectRoot: string, definition: DiscoveredWorkflowDefinition): ViteHubDefinitionSummary {
  return {
    fields: [
      ...(definition.agentIdentity
        ? [{ label: "Agent identity", value: definition.agentIdentity }]
        : []),
      ...(definition.steps?.length
        ? [{
            label: "Steps",
            value: definition.steps
              .map(step => relativeDefinitionFile(projectRoot, step))
              .join(", "),
          }]
        : []),
    ],
    file: relativeDefinitionFile(projectRoot, definition.handler),
    name: definition.name,
    source: definition.source || "workflow",
  }
}

/** Lists user-facing Workflow Definitions. Generated Agent recovery Workflows are internal and stay hidden. */
export function inspectWorkflowDefinitions(options: WorkflowInspectionOptions): ViteHubDefinitionSummary[] {
  return discoverWorkflowDefinitions({ rootDir: options.rootDir, serverDirs: options.serverDirs })
    .filter(definition => definition.source !== "agent-workflow-recovery")
    .map(definition => summarizeWorkflowDefinition(options.projectRoot, definition))
}
