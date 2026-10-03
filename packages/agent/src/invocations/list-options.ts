import { agentDiagnostics } from "../agent-diagnostics.ts"
import { hasRuntimeType } from "../internal/runtime-type.ts"

import type { AgentInvocationListOptions } from "../invocations.ts"

const DEFAULT_LIST_LIMIT = 50
export const maxAgentInvocationListLimit = 100

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT
  if (!Number.isInteger(limit) || limit < 1) {
    throw agentDiagnostics.AGENT_R0618({ message: "[vitehub] Agent Invocation list limit must be a positive integer." })
  }
  return Math.min(limit, maxAgentInvocationListLimit)
}

function normalizeSearch(search: string | undefined): string | undefined {
  if (search === undefined) return
  if (!hasRuntimeType(search, "string")) {
    throw agentDiagnostics.AGENT_R0619({ message: "[vitehub] Agent Invocation search must be a string." })
  }
  const value = search.trim()
  if (!value) return
  if (value.length > 256) {
    throw agentDiagnostics.AGENT_R0620({ message: "[vitehub] Agent Invocation search must be at most 256 characters." })
  }
  return value
}

function normalizeBuiltInCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return
  const value = Number(cursor)
  if (!Number.isSafeInteger(value) || value < 1 || String(value) !== cursor) {
    throw agentDiagnostics.AGENT_R0621({ message: "[vitehub] Agent Invocation cursor is invalid." })
  }
  return cursor
}

/** Apply shared list rules while leaving custom store cursors opaque. */
export function normalizeAgentInvocationListOptions(
  options: AgentInvocationListOptions,
  { sequenceCursor = false }: { sequenceCursor?: boolean } = {},
): AgentInvocationListOptions & { limit: number } {
  const normalized = { ...options, limit: normalizeLimit(options.limit) }
  const search = normalizeSearch(options.search)
  if (search) normalized.search = search
  else delete normalized.search
  for (const key of ["agentName", "capabilityId", "triggeredBy"] as const) {
    const value = options[key]?.trim()
    if (value) normalized[key] = value
    else delete normalized[key]
  }
  if (sequenceCursor) normalizeBuiltInCursor(options.cursor)
  return normalized
}
