import { summarizeDefinitions } from "@vite-hub/internal/inspect"

import { discoverQueueDefinitions } from "./discovery.ts"

import type { ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"

export interface QueueInspectionOptions {
  projectRoot: string
  rootDir: string
  serverDirs?: string[]
}

/** Summarizes discovered Queue Definitions for the CLI and Console. */
export function inspectQueueDefinitions(options: QueueInspectionOptions): ViteHubDefinitionSummary[] {
  return summarizeDefinitions(
    options.projectRoot,
    discoverQueueDefinitions({ rootDir: options.rootDir, serverDirs: options.serverDirs }),
    "queue",
  )
}
