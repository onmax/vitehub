import {
  createDirectoryDefinitionSource,
  discoverDefinitions,
  normalizePathDefinitionName,
} from "@vite-hub/internal/definition-catalog"
import { resolve } from "pathe"

import type { DiscoveredConnectionDefinition } from "./types.ts"

/** Discovers `server/connections/<name>.ts`. The file path is the Connection name. */
export function discoverConnectionDefinitions(options: { rootDir: string, serverDirs?: string[] }): DiscoveredConnectionDefinition[] {
  const serverDirs = options.serverDirs ?? [resolve(options.rootDir, "server")]
  return discoverDefinitions("connection", [
    createDirectoryDefinitionSource("server-connections", serverDirs, "connections", {
      createDefinition: (context: { file: string, name: string }): DiscoveredConnectionDefinition => ({
        handler: context.file,
        name: context.name,
        source: "server-connections",
      }),
      normalizeName: normalizePathDefinitionName,
    }),
  ])
}
