import definitionDefaults from "#vitehub/database/definition-defaults"
import { resolveRuntimeCloudflareConfig } from "../internal/cloudflare.ts"

import type { DatabaseDefinition, RuntimeDrizzleDatabaseConfig } from "../types.ts"

interface DatabaseDefinitionDefaults {
  cloudflare?: DatabaseDefinition["cloudflare"]
  cloudflareBindings?: Record<string, string>
  connection?: DatabaseDefinition["connection"]
}

function defaultUrl(name: string) {
  if (name === "default") return "file:.vitehub/data/database/sqlite.db"
  return `file:.vitehub/data/database/${name}.sqlite.db`
}

export function runtimeConfig(
  definition: DatabaseDefinition,
  defaults: DatabaseDefinitionDefaults = definitionDefaults,
): RuntimeDrizzleDatabaseConfig {
  const cloudflare = resolveRuntimeCloudflareConfig(defaults.cloudflare, definition.cloudflare, {
    binding: defaults.cloudflareBindings?.[definition.name],
    name: definition.name,
  })
  const config: RuntimeDrizzleDatabaseConfig = {
    connection: {
      authToken: definition.connection?.authToken ?? defaults.connection?.authToken,
      url: definition.connection?.url ?? defaults.connection?.url ?? defaultUrl(definition.name),
    },
    drizzle: definition.drizzle,
    name: definition.name,
  }
  if (cloudflare) config.cloudflare = cloudflare
  return config
}
