import { ViteHubError } from "@vite-hub/runtime"

import type { WorkspaceCollectionFacetValue, WorkspaceCollectionFilter, WorkspaceCollectionItem, WorkspaceCollectionItemQuery, WorkspaceCollectionPage, WorkspaceCollectionQuery } from "../collections.ts"
import { workspaceErrorDiagnostics } from "../error-diagnostics.ts"

interface CollectionPageLimits {
  defaultLimit?: number
  maxLimit?: number
  query?: WorkspaceCollectionQuery
}

function workspaceCollectionCursorError(reason: "malformed" | "stale") {
  return new ViteHubError("WORKSPACE_COLLECTION_CURSOR_INVALID", reason === "stale" ? "Workspace collection cursor is stale." : "Workspace collection cursor is malformed.", {
    details: { reason },
  })
}

interface CollectionCursor {
  digest: string
  offset: number
  query: string
}

const defaultPageLimit = 50
const defaultMaxLimit = 100

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function valueAt(value: unknown, path: string): unknown {
  const segments = path.split(".").filter(Boolean)
  function visit(current: unknown, remaining: string[]): unknown {
    if (!remaining.length) return current
    if (Array.isArray(current)) {
      return current.map(item => visit(item, remaining)).filter(item => item !== undefined)
    }
    if (!isRecord(current)) return
    return visit(current[remaining[0]!], remaining.slice(1))
  }
  return visit(value, segments)
}

function scalarValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(scalarValues)
  if (value === null || value === undefined || typeof value === "object") return []
  return [String(value)]
}

function matchesFilter(value: unknown, expected: WorkspaceCollectionFilter | undefined): boolean {
  const values = scalarValues(value).map(item => item.toLocaleLowerCase())
  if (typeof expected === "object" && !Array.isArray(expected)) return expected.empty && values.length === 0
  const candidates = (Array.isArray(expected) ? expected : [expected])
    .filter((item): item is string => item !== undefined)
    .map(item => item.toLocaleLowerCase())
  if (!candidates.length) return true
  return candidates.some(candidate => values.includes(candidate))
}

function project<T>(item: unknown, select: string[] | undefined): T {
  if (!select?.length) return item as T
  return Object.fromEntries(select.map(field => [field, valueAt(item, field)])) as T
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

function normalizedFilters(filters: WorkspaceCollectionQuery["filters"]): Record<string, string[]> {
  return Object.fromEntries(Object.entries(filters || {})
    .filter((entry): entry is [string, WorkspaceCollectionFilter] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([field, value]) => [field, typeof value === "object" && !Array.isArray(value)
      ? ["operator:empty"]
      : (Array.isArray(value) ? value : [value]).map(item => `value:${item.toLocaleLowerCase()}`).sort()]))
}

async function queryDigest(query: WorkspaceCollectionQuery, limit: number): Promise<string> {
  return await digest(JSON.stringify({
    facets: [...(query.facets || [])].sort(),
    filters: normalizedFilters(query.filters),
    limit,
    search: String(query.search || "").trim().toLocaleLowerCase(),
    searchFields: [...(query.searchFields || [])].sort(),
    select: query.select || [],
    sort: query.sort ? { direction: query.sort.direction || "asc", field: query.sort.field } : null,
  }))
}

function encodeCursor(cursor: CollectionCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function decodeCursor(cursor: string | undefined, expected: Omit<CollectionCursor, "offset">): number {
  if (!cursor) return 0
  let parsed: unknown
  try {
    const normalized = cursor.replaceAll("-", "+").replaceAll("_", "/")
    parsed = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")))
  }
  catch {
    throw workspaceCollectionCursorError("malformed")
  }
  if (!isRecord(parsed) || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0 || typeof parsed.digest !== "string" || typeof parsed.query !== "string") {
    throw workspaceCollectionCursorError("malformed")
  }
  if (parsed.digest !== expected.digest || parsed.query !== expected.query) {
    throw workspaceCollectionCursorError("stale")
  }
  return Number(parsed.offset)
}

function resolveLimit(query: WorkspaceCollectionQuery, options: CollectionPageLimits): number {
  const maxLimit = options.maxLimit ?? defaultMaxLimit
  const fallback = options.defaultLimit ?? defaultPageLimit
  if (!Number.isSafeInteger(maxLimit) || maxLimit < 1) throw workspaceErrorDiagnostics.WORKSPACE_R0012({ message: "Workspace collection maxLimit must be a positive integer." })
  if (!Number.isSafeInteger(fallback) || fallback < 1) throw workspaceErrorDiagnostics.WORKSPACE_R0013({ message: "Workspace collection defaultLimit must be a positive integer." })
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) {
    throw workspaceErrorDiagnostics.WORKSPACE_R0014({ message: "Workspace collection limit must be a positive integer." })
  }
  return Math.min(query.limit ?? fallback, maxLimit)
}

function filterItems(items: unknown[], query: WorkspaceCollectionQuery): unknown[] {
  const search = String(query.search || "").trim().toLocaleLowerCase()
  let filtered = items.filter(item => Object.entries(query.filters || {}).every(([field, expected]) => matchesFilter(valueAt(item, field), expected)))
  if (search) {
    filtered = filtered.filter(item => (query.searchFields || []).some(field => scalarValues(valueAt(item, field)).some(value => value.toLocaleLowerCase().includes(search))))
  }
  if (query.sort?.field) {
    const direction = query.sort.direction === "desc" ? -1 : 1
    filtered = [...filtered].sort((left, right) => {
      const leftValue = valueAt(left, query.sort!.field)
      const rightValue = valueAt(right, query.sort!.field)
      const leftScalar = Array.isArray(leftValue) ? leftValue.flat(Infinity).find(value => value !== null && value !== undefined && typeof value !== "object") : leftValue
      const rightScalar = Array.isArray(rightValue) ? rightValue.flat(Infinity).find(value => value !== null && value !== undefined && typeof value !== "object") : rightValue
      if (typeof leftScalar === "number" && typeof rightScalar === "number") return (leftScalar - rightScalar) * direction
      return String(leftScalar ?? "").localeCompare(String(rightScalar ?? "")) * direction
    })
  }
  return filtered
}

function buildFacets(items: unknown[], fields: string[] | undefined, maxValues: number): Record<string, WorkspaceCollectionFacetValue[]> {
  return Object.fromEntries((fields || []).map((field) => {
    const counts = new Map<string, number>()
    for (const item of items) {
      for (const value of new Set(scalarValues(valueAt(item, field)))) {
        counts.set(value, (counts.get(value) || 0) + 1)
      }
    }
    const values = [...counts].map(([value, count]) => ({ count, value }))
      .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
      .slice(0, maxValues)
    return [field, values]
  }))
}

/** Evaluate one JSON snapshot without depending on a Workspace or its filesystem. */
export async function createWorkspaceCollectionQuery(raw: string, snapshot: { digest?: string, path: string }) {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw workspaceErrorDiagnostics.WORKSPACE_R0011({ message: `Workspace collection ${snapshot.path} must contain a JSON array.` })
  const items: unknown[] = parsed
  const contentDigest = snapshot.digest || await digest(raw)

  return {
    async page<T = Record<string, unknown>>(options: CollectionPageLimits = {}): Promise<WorkspaceCollectionPage<T>> {
      const query = options.query || {}
      const filtered = filterItems(items, query)
      const limit = resolveLimit(query, options)
      const signature = await queryDigest(query, limit)
      const offset = decodeCursor(query.cursor, { digest: contentDigest, query: signature })
      if (offset > filtered.length) throw workspaceCollectionCursorError("malformed")
      const pageItems = filtered.slice(offset, offset + limit).map(item => project<T>(item, query.select))
      const nextOffset = offset + pageItems.length
      return {
        digest: contentDigest,
        facets: buildFacets(filtered, query.facets, options.maxLimit ?? defaultMaxLimit),
        items: pageItems,
        nextCursor: nextOffset < filtered.length ? encodeCursor({ digest: contentDigest, offset: nextOffset, query: signature }) : null,
        total: filtered.length,
      }
    },
    get<T = Record<string, unknown>>(query: WorkspaceCollectionItemQuery): WorkspaceCollectionItem<T> {
      const expected = String(query.value)
      const item = items.find(item => scalarValues(valueAt(item, query.key)).some(value => value === expected))
      return {
        digest: contentDigest,
        item: item === undefined ? null : project<T>(item, query.select),
      }
    },
  }
}
