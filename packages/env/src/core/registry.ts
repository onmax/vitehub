import type { EnvValueSchema } from "../types.ts"

export interface RuntimeEnvEntry {
  default?: unknown
  required: boolean
  schema?: EnvValueSchema
  secret: boolean
  source: { kind: "env", label: string, name: string, names?: string[], skipEmpty?: boolean }
}

export interface RuntimeProviderEntry {
  default?: unknown
  required: boolean
  schema?: EnvValueSchema
  secret: boolean
  source: { key: string, kind: "provider", label: "provider", provider: string }
}

export interface RuntimeLiteralEntry {
  kind: "literal"
  value: unknown
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isRuntimeLiteralEntry(value: unknown): value is RuntimeLiteralEntry {
  return isRecord(value) && value.kind === "literal"
}

export function isRuntimeEnvEntry(value: unknown): value is RuntimeEnvEntry {
  return isRecord(value)
    && isRecord(value.source)
    && value.source.kind === "env"
    && typeof value.source.name === "string"
    && typeof value.required === "boolean"
    && typeof value.secret === "boolean"
}

export function isRuntimeProviderEntry(value: unknown): value is RuntimeProviderEntry {
  return isRecord(value)
    && isRecord(value.source)
    && value.source.kind === "provider"
    && typeof value.source.key === "string"
    && typeof value.source.provider === "string"
    && typeof value.required === "boolean"
    && typeof value.secret === "boolean"
}

export type RuntimeRegistryEntry = RuntimeLiteralEntry | RuntimeEnvEntry | RuntimeProviderEntry

/** Visits declarations once. Literal values and declaration metadata are opaque to traversal. */
export function* runtimeRegistryEntries(value: unknown, path = "env.server"): Generator<{ entry: RuntimeRegistryEntry, path: string }> {
  if (isRuntimeLiteralEntry(value) || isRuntimeEnvEntry(value) || isRuntimeProviderEntry(value)) {
    yield { entry: value, path }
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    yield* runtimeRegistryEntries(child, `${path}.${key.includes(".") ? "!" : ""}${key}`)
  }
}
