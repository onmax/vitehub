import { relative } from "pathe"

export interface ViteHubDefinitionField {
  label: string
  value: string
}

/** Serializable summary of one discovered Definition. Files are relative to the project root. */
export interface ViteHubDefinitionSummary {
  fields: readonly ViteHubDefinitionField[]
  file: string
  name: string
  source: string
}

/** Lists the Definitions that one owner package discovered for the resolved Vite config. */
export interface ViteHubDefinitionInspector {
  /** Stable singular kind, for example `queue` or `rate-limit`. */
  kind: string
  label: string
  list: () => Promise<readonly ViteHubDefinitionSummary[]> | readonly ViteHubDefinitionSummary[]
}

/** One generated Provider Output file or directory that an owner package can write. */
export interface ViteHubProviderOutputEntry {
  description: string
  owner: string
  /** Absolute path. */
  path: string
}

export interface ViteHubInspectionContributor {
  definitions?: readonly ViteHubDefinitionInspector[]
  providerOutput?: readonly ViteHubProviderOutputEntry[]
}

export type ViteHubInspectionContributorFactory = () =>
  | ViteHubInspectionContributor
  | undefined
  | Promise<ViteHubInspectionContributor | undefined>

export interface ViteHubInspectionPluginMetadata {
  inspect?: ViteHubInspectionContributor | ViteHubInspectionContributorFactory
}

export interface ViteHubInspectionContributingPlugin {
  vitehub?: ViteHubInspectionPluginMetadata
}

async function collectContributors(plugins: readonly unknown[]): Promise<ViteHubInspectionContributor[]> {
  const contributors: ViteHubInspectionContributor[] = []
  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== "object") continue
    const value = (plugin as ViteHubInspectionContributingPlugin).vitehub?.inspect
    const contributor = typeof value === "function" ? await value() : value
    if (contributor) contributors.push(contributor)
  }
  return contributors
}

/** Collects Definition inspectors from active plugins. A later plugin replaces an earlier inspector of the same kind. */
export async function collectViteHubDefinitionInspectors(plugins: readonly unknown[]): Promise<ViteHubDefinitionInspector[]> {
  const inspectors = new Map<string, ViteHubDefinitionInspector>()
  for (const contributor of await collectContributors(plugins)) {
    for (const inspector of contributor.definitions ?? []) inspectors.set(inspector.kind, inspector)
  }
  return [...inspectors.values()]
}

/** Collects Provider Output entries from active plugins, keyed by path. */
export async function collectViteHubProviderOutputEntries(plugins: readonly unknown[]): Promise<ViteHubProviderOutputEntry[]> {
  const entries = new Map<string, ViteHubProviderOutputEntry>()
  for (const contributor of await collectContributors(plugins)) {
    for (const entry of contributor.providerOutput ?? []) entries.set(entry.path, entry)
  }
  return [...entries.values()]
}

export function relativeDefinitionFile(projectRoot: string, file: string): string {
  return relative(projectRoot, file).replaceAll("\\", "/")
}

/** Summarizes Definitions that have no owner-specific fields. */
export function summarizeDefinitions(
  projectRoot: string,
  definitions: readonly { handler: string, name: string, source?: string }[],
  fallbackSource: string,
): ViteHubDefinitionSummary[] {
  return definitions.map(definition => ({
    fields: [],
    file: relativeDefinitionFile(projectRoot, definition.handler),
    name: definition.name,
    source: definition.source || fallbackSource,
  }))
}

export const redactedInspectionValue = "[redacted]"

const secretKeyPattern = /secret|token|passw(?:or)?d|credential|api[-_\s]?key|private[-_\s]?key|authorization|cookie|signature|dsn|connection[-_\s]?string/i
const secretValuePattern = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@|bearer\s)/i

const embeddedUrlCredentialPattern = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi
const embeddedBearerPattern = /\bbearer\s+[^\s,;]+/gi
const embeddedSecretAssignmentPattern = /\b((?:[\w-]*(?:secret|token|passw(?:or)?d|api[-_]?key|authorization))\s*[:=]\s*)[^\s,;&]+/gi

/**
 * Removes credentials inside free text, for example an error message. URL credentials, bearer tokens, and
 * `name=value` pairs with a secret name are replaced with `[redacted]`.
 */
export function redactInspectionText(value: string): string {
  return value
    .replace(embeddedUrlCredentialPattern, `$1${redactedInspectionValue}@`)
    .replace(embeddedBearerPattern, `Bearer ${redactedInspectionValue}`)
    .replace(embeddedSecretAssignmentPattern, `$1${redactedInspectionValue}`)
}

/**
 * Removes values that can carry credentials before inspection output leaves the process.
 * Keys that name secrets, plaintext Worker `vars`, and URLs with embedded credentials are redacted.
 */
export function redactInspectionValue(value: unknown, key?: string): unknown {
  if (key && secretKeyPattern.test(key)) return redactedInspectionValue
  if (typeof value === "string") return secretValuePattern.test(value) ? redactedInspectionValue : value
  if (Array.isArray(value)) return value.map(entry => redactInspectionValue(entry))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [
    entryKey,
    entryKey === "vars" && entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.keys(entry).map(name => [name, redactedInspectionValue]))
      : redactInspectionValue(entry, entryKey),
  ]))
}
