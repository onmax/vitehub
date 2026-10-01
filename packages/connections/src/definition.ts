import { connectionError } from "./errors.ts"
import { assertConnectionOrigins, assertConnectionProviderId } from "./origins.ts"

import type { ConnectionAccessRule, ConnectionDefinition, ConnectionProvider } from "./types.ts"

function assertPatterns(value: unknown, path: string): void {
  if (value === undefined) return
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Connection Definitions can come from JavaScript files, so the shape is checked at runtime.
  if (!Array.isArray(value) || value.some(pattern => typeof pattern !== "string" || !pattern.trim())) {
    throw connectionError("invalid", { path })
  }
}

function assertRule(rule: ConnectionAccessRule | undefined, path: string): void {
  if (rule === undefined) return
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Connection Definitions can come from JavaScript files, so the shape is checked at runtime.
  if (!rule || typeof rule !== "object") throw connectionError("invalid", { path })
  assertPatterns(rule.allow, `${path}.allow`)
  assertPatterns(rule.approve, `${path}.approve`)
  assertPatterns(rule.deny, `${path}.deny`)
}

// RFC 9110 token characters, as `apiKey()` checks them.
const tokenPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

function assertApiKeyProvider(provider: ConnectionProvider): void {
  if (provider.kind !== "api-key") return
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Connection Definitions can come from JavaScript files, so the shape is checked at runtime.
  const text = (value: unknown): value is string => typeof value === "string"
  if (!text(provider.id) || !provider.id || !text(provider.header) || !tokenPattern.test(provider.header) || provider.header !== provider.header.toLowerCase()) {
    throw connectionError("invalid", { path: "provider" })
  }
  if (!Array.isArray(provider.scopes) || provider.scopes.some(scope => !text(scope))) throw connectionError("invalid", { path: "provider.scopes" })
  if (provider.scheme !== undefined && (!text(provider.scheme) || !tokenPattern.test(provider.scheme))) throw connectionError("invalid", { path: "provider.scheme" })
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Connection Definitions can come from JavaScript files, so the shape is checked at runtime.
  if (provider.verify !== undefined && typeof provider.verify !== "function") throw connectionError("invalid", { path: "provider.verify" })
}

/** Declares a Connection in `server/connections/<name>.ts`. The file name is the Connection name. */
export function defineConnection<TProvider extends ConnectionProvider>(
  definition: ConnectionDefinition<TProvider>,
): ConnectionDefinition<TProvider> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Connection Definitions can come from JavaScript files, so the shape is checked at runtime.
  if (!definition || typeof definition !== "object" || !definition.provider || (definition.provider.kind !== "oauth2" && definition.provider.kind !== "api-key")) {
    throw connectionError("invalid", { path: "provider" })
  }
  assertConnectionProviderId(definition.provider.id)
  assertConnectionOrigins(definition.provider.origins)
  assertApiKeyProvider(definition.provider)
  assertRule(definition.access?.server, "access.server")
  for (const [name, rule] of Object.entries(definition.access?.routes ?? {})) assertRule(rule, `access.routes.${name}`)
  for (const [name, rule] of Object.entries(definition.access?.agents ?? {})) assertRule(rule, `access.agents.${name}`)
  return definition
}
