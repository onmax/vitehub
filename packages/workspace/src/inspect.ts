import { relativeDefinitionFile } from "@vite-hub/internal/inspect"

import { discoverViteWorkspaceDefinitions } from "./build/discovery.ts"

import type { ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"

export interface WorkspaceInspectionOptions {
  projectRoot: string
  rootDir: string
  serverDirs?: string[]
  serverRootDir: string
}

/** Lists Workspace Definitions and Agent workspaces as serializable inspection summaries. */
export function inspectWorkspaceDefinitions(options: WorkspaceInspectionOptions): ViteHubDefinitionSummary[] {
  return discoverViteWorkspaceDefinitions(options.rootDir, {
    serverDirs: options.serverDirs,
    serverRootDir: options.serverRootDir,
  }).map(definition => ({
    fields: [
      { label: "Kind", value: definition.source === "server-agent-workspaces" ? "Agent workspace" : "Workspace Definition" },
      ...(definition.sourceRootDir
        ? [{ label: "Source root", value: relativeDefinitionFile(options.projectRoot, definition.sourceRootDir) }]
        : []),
    ],
    file: relativeDefinitionFile(options.projectRoot, definition.handler),
    name: definition.name,
    source: definition.source || "workspace",
  }))
}
