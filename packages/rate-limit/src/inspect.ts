import { relativeDefinitionFile } from "@vite-hub/internal/inspect"

import { discoverRateLimitDeclarations } from "./discovery.ts"

import type { ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"
import type { RateLimitDeclaration } from "./types.ts"

export interface RateLimitInspectionOptions {
  projectRoot: string
  rootDir: string
  scanDirs?: string[]
}

function summarizeRateLimitDeclaration(projectRoot: string, declaration: RateLimitDeclaration): ViteHubDefinitionSummary {
  return {
    fields: [
      { label: "Limit", value: String(declaration.policy.limit) },
      { label: "Window", value: declaration.policy.window },
      { label: "Enforcement", value: declaration.policy.enforcement === "strict" ? "Strict" : "Best effort" },
      { label: "Provider failure", value: declaration.policy.failure === "allow" ? "Allow" : "Deny" },
      { label: "Source location", value: `${declaration.source.line}:${declaration.source.column}` },
    ],
    file: relativeDefinitionFile(projectRoot, declaration.source.file),
    name: declaration.name,
    source: "require-rate-limit",
  }
}

/** Lists `requireRateLimit()` declarations as serializable inspection summaries. */
export function inspectRateLimitDefinitions(options: RateLimitInspectionOptions): ViteHubDefinitionSummary[] {
  return discoverRateLimitDeclarations({ rootDir: options.rootDir, scanDirs: options.scanDirs })
    .map(declaration => summarizeRateLimitDeclaration(options.projectRoot, declaration))
}
