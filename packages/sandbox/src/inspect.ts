import { relativeDefinitionFile } from '@vite-hub/internal/inspect'

import { discoverSandboxDefinitions } from './discovery'

import type { ViteHubDefinitionSummary } from '@vite-hub/internal/inspect'

export interface SandboxInspectionOptions {
  projectRoot: string
  rootDir: string
}

/** Lists Sandbox Definitions and package entries as serializable inspection summaries. */
export function inspectSandboxDefinitions(options: SandboxInspectionOptions): ViteHubDefinitionSummary[] {
  return discoverSandboxDefinitions({ rootDir: options.rootDir }).map(definition => ({
    fields: [{ label: 'Kind', value: definition.kind === 'package-entry' ? 'Package entry' : 'Definition' }],
    file: relativeDefinitionFile(options.projectRoot, definition.handler),
    name: definition.name,
    source: definition.source,
  }))
}
