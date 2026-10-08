import { resolveCloudflareD1BindingName } from "./cloudflare.ts"

import type { ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../types.ts"

function renderConfigExpression(value: unknown) {
  return typeof value === "undefined" ? "undefined" : JSON.stringify(value)
}

function serializeDatabaseConfig({ cloudflare: _cloudflare, connection: _connection, drizzle: _drizzle, ...database }: ResolvedDrizzleDatabaseConfig) {
  return JSON.stringify(database, null, 4)
}

export function renderDatabaseConfigExpression(name: string, config: ResolvedDBViteConfig, definitionVariable: string) {
  const base = config.databases[name]!
  const definitionCloudflareDefaults = config.definitionDefaults.cloudflare
    ? {
        ...config.definitionDefaults.cloudflare,
        binding: base.cloudflare?.binding ?? resolveCloudflareD1BindingName("default", config.definitionDefaults.cloudflare.binding),
      }
    : undefined
  const baseHttp = base.cloudflare?.http
  const baseHttpConfig = baseHttp && baseHttp !== true ? baseHttp : undefined
  const http = `${definitionVariable}.cloudflare.http === true ? true : ${definitionVariable}.cloudflare.http ? { authToken: ${definitionVariable}.cloudflare.http.authToken ?? ${renderConfigExpression(baseHttpConfig?.authToken)}, url: ${definitionVariable}.cloudflare.http.url ?? ${renderConfigExpression(baseHttpConfig?.url)} } : ${renderConfigExpression(baseHttp)}`
  return [
    "{",
    `      ...${serializeDatabaseConfig(base)},`,
    `      cloudflare: ${definitionVariable}.cloudflare ? { binding: ${definitionVariable}.cloudflare.binding ?? ${JSON.stringify(base.cloudflare?.binding ?? resolveCloudflareD1BindingName(name, undefined))}, databaseId: ${definitionVariable}.cloudflare.databaseId ?? ${renderConfigExpression(base.cloudflare?.databaseId)}, databaseName: ${definitionVariable}.cloudflare.databaseName ?? ${renderConfigExpression(base.cloudflare?.databaseName)}, http: ${http}, migrationsDir: ${JSON.stringify(base.migrationsDir)}, migrationsTable: ${definitionVariable}.cloudflare.migrationsTable ?? ${renderConfigExpression(base.cloudflare?.migrationsTable)}, previewDatabaseId: ${definitionVariable}.cloudflare.previewDatabaseId ?? ${renderConfigExpression(base.cloudflare?.previewDatabaseId)} } : ${renderConfigExpression(definitionCloudflareDefaults)},`,
    `      connection: ${definitionVariable}.connection ? { authToken: ${definitionVariable}.connection.authToken ?? ${renderConfigExpression(base.connection?.authToken)}, url: ${definitionVariable}.connection.url ?? ${renderConfigExpression(base.connection?.url)} } : ${renderConfigExpression(base.connection)},`,
    `      drizzle: ${definitionVariable}.drizzle ?? {},`,
    "    }",
  ].join("\n")
}
