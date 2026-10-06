/** Sections that the Console UI in `vite-hub` renders with its own components. Owner packages contribute the others. */
export const consoleBuiltinSectionIds = ["env", "connections", "agents", "usage", "blob", "databases", "kv"] as const

export type ConsoleBuiltinSectionId = (typeof consoleBuiltinSectionIds)[number]

/** A built-in section id or the id of a section that an owner package contributes. */
export type ConsoleSectionId = string

export interface ConsoleSectionDetails {
  readonly description: string
  readonly icon: string
  readonly label: string
  readonly routeName: string
}

/** Details of built-in sections. Contributed sections get their details from the navigation response. */
export const consoleSectionDetails: Readonly<Record<ConsoleBuiltinSectionId, ConsoleSectionDetails>> = {
  env: { description: "Inspect Server Env declarations and their providers.", icon: "i-ph-key-light", label: "Env", routeName: "vitehub-console-env" },
  connections: {
    description: "Inspect and manage app-owned OAuth Connections.",
    icon: "i-ph-plugs-connected-light",
    label: "Connections",
    routeName: "vitehub-console-connections",
  },
  agents: {
    description: "Inspect Agent sessions and invocation details.",
    icon: "i-ph-robot-light",
    label: "Agents",
    routeName: "vitehub-console-agents",
  },
  usage: {
    description: "Review token use and cost evidence over time.",
    icon: "i-ph-chart-bar-light",
    label: "Usage",
    routeName: "vitehub-console-usage",
  },
  blob: {
    description: "Inspect configured Blob stores and object metadata without downloading contents.",
    icon: "i-lucide-file-box",
    label: "Blob",
    routeName: "vitehub-console-blob",
  },
  databases: {
    description: "Inspect discovered Database Definitions and static schema metadata.",
    icon: "i-lucide-database",
    label: "Databases",
    routeName: "vitehub-console-databases",
  },
  kv: {
    description: "Inspect configured KV stores without changing data.",
    icon: "i-lucide-book-key",
    label: "KV",
    routeName: "vitehub-console-kv",
  },
}

/** Navigation groups in rail order. A contributed section with an unknown id goes to `more`. */
export const consoleSectionGroupIds = ["agents", "data", "runtime", "platform", "more"] as const

export type ConsoleSectionGroupId = (typeof consoleSectionGroupIds)[number]

const consoleSectionGroupBySection: Readonly<Record<string, ConsoleSectionGroupId>> = {
  agents: "agents",
  usage: "agents",
  databases: "data",
  kv: "data",
  blob: "data",
  workspaces: "data",
  workflows: "runtime",
  queues: "runtime",
  schedules: "runtime",
  sandboxes: "runtime",
  env: "platform",
  connections: "platform",
  email: "platform",
  "rate-limits": "platform",
}

/** Splits enabled sections into navigation groups. Keeps the given order inside each group and drops empty groups. */
export function groupConsoleSections<T extends { id: ConsoleSectionId }>(sections: readonly T[]): T[][] {
  return consoleSectionGroupIds
    .map(group => sections.filter(section => (Object.hasOwn(consoleSectionGroupBySection, section.id) ? consoleSectionGroupBySection[section.id] : "more") === group))
    .filter(group => group.length > 0)
}

/** First key of every "Go to" chord, as in Linear and GitHub. */
export const consoleGoToKey = "g"

/** Keys that open the Overview: `g` and then `o`. */
export const consoleOverviewShortcut: readonly [typeof consoleGoToKey, "o"] = [consoleGoToKey, "o"]

/** Second key of the "Go to" chord of each known section. Each key is unique and is not `o`. */
export const consoleSectionShortcutKeys: Readonly<Record<string, string>> = {
  agents: "a",
  usage: "u",
  databases: "d",
  kv: "k",
  blob: "b",
  workspaces: "w",
  workflows: "f",
  queues: "q",
  schedules: "s",
  sandboxes: "x",
  env: "e",
  connections: "c",
  email: "m",
  "rate-limits": "r",
}

/** Returns the "Go to" chord keys of a section. A contributed section with an unknown id has no chord. */
export function consoleSectionShortcut(section: ConsoleSectionId): readonly [typeof consoleGoToKey, string] | undefined {
  return Object.hasOwn(consoleSectionShortcutKeys, section)
    ? [consoleGoToKey, consoleSectionShortcutKeys[section]!]
    : undefined
}

interface ConsoleSectionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const lastConsoleSectionStorageKey = "vitehub-console:last-section"
const consoleSectionIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Returns true for a lowercase route segment. Built-in and contributed section ids use this form. */
export function isConsoleSectionId(value: unknown): value is ConsoleSectionId {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Section ids come from untrusted JSON and browser storage.
  return typeof value === "string" && consoleSectionIdPattern.test(value)
}

export function isConsoleBuiltinSectionId(value: unknown): value is ConsoleBuiltinSectionId {
  return consoleBuiltinSectionIds.some(section => section === value)
}

/** Connections management is mounted for development Consoles and explicit production management. */
export function isConsoleConnectionsEnabled(options: { connections?: unknown }, development = false): boolean {
  const connections = options.connections
  if (!connections) return false
  if (development) return true
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Options cross the host boundary as unknown values.
  if (typeof connections !== "object" || connections === null) return false
  return "management" in connections && Boolean(connections.management)
}

/** Route name of a contributed section. The Console serves it at `/_vitehub/<id>`. */
export function consoleSectionRouteName(section: ConsoleSectionId): string {
  return `vitehub-console-${section}`
}

/**
 * Returns the enabled section ids in navigation order. Owner packages contribute `rate-limits`, `sandboxes`,
 * `workspaces`, `workflows`, `queues`, and `schedules`. `console/contributions.ts` maps each id to its owner.
 */
export function resolveConsoleSectionIds(options: { env?: unknown; connections?: unknown; agent?: unknown; blob?: unknown; database?: unknown; email?: unknown; kv?: unknown; preset?: unknown; queue?: unknown; rateLimit?: unknown; sandbox?: unknown; schedule?: unknown; workflow?: unknown; workspace?: unknown }): ConsoleSectionId[] {
  const workflowEnabled = options.workflow !== false
    && Boolean(options.workflow || (options.agent && options.preset !== "netlify"))
  return [
    ...(options.env ? ["env"] : []),
    ...(options.connections ? ["connections"] : []),
    ...(options.agent ? ["agents", "usage"] : []),
    ...(options.blob ? ["blob"] : []),
    ...(options.database ? ["databases"] : []),
    ...(options.email ? ["email"] : []),
    ...(options.kv ? ["kv"] : []),
    ...(options.rateLimit ? ["rate-limits"] : []),
    ...(options.sandbox ? ["sandboxes"] : []),
    ...(options.workspace ? ["workspaces"] : []),
    ...(workflowEnabled ? ["workflows"] : []),
    ...(options.queue ? ["queues"] : []),
    ...(options.schedule ? ["schedules"] : []),
  ]
}

export function prioritizeConsoleSectionIds(
  sections: readonly ConsoleSectionId[],
  preferred: ConsoleSectionId | undefined,
): ConsoleSectionId[] {
  return preferred && sections.includes(preferred)
    ? [preferred, ...sections.filter(section => section !== preferred)]
    : [...sections]
}

export function readLastConsoleSection(storage?: ConsoleSectionStorage): ConsoleSectionId | undefined {
  try {
    const target = storage ?? globalThis.localStorage
    const value = target?.getItem(lastConsoleSectionStorageKey)
    return isConsoleSectionId(value) ? value : undefined
  }
  catch {
    return undefined
  }
}

export function rememberConsoleSection(
  section: ConsoleSectionId,
  storage?: ConsoleSectionStorage,
): void {
  try {
    const target = storage ?? globalThis.localStorage
    target?.setItem(lastConsoleSectionStorageKey, section)
  }
  catch {
    // Browser privacy settings can disable local storage. Navigation must still work.
  }
}
