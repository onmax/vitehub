/** Vite Development Server route that `vitehub kv` commands call. */
export const kvDevRoute = "/__vitehub/kv/dev"
/** Nitro route that the dev endpoint forwards KV operations to. The route exists only in `vite dev`. */
export const kvDevRuntimeRoute = "/_vitehub/kv/dev"
export const kvDevHeader = "x-vitehub-kv-dev"
export const kvDevHeaderValue = "1"

/** KV operations that the dev endpoint accepts. There is no `clear` operation. */
export const kvDevOperations = ["list", "get", "has", "set", "del"] as const

export type KVDevOperation = typeof kvDevOperations[number]

/** Largest `--limit` of one `list` page. */
export const kvDevMaximumListLimit = 1_000
/** Default `--limit` of one `list` page. */
export const kvDevDefaultListLimit = 100

export interface KVDevRequestBody {
  cursor?: string
  key?: string
  limit?: number
  operation: KVDevOperation
  prefix?: string
  /** Store name. Defaults to `default`. */
  store?: string
  /** Time to live in seconds for `set`. */
  ttl?: number
  /** Value for `set`. The CLI sends a string, or a parsed JSON value with `--json-value`. */
  value?: unknown
}

export function isKVDevOperation(value: unknown): value is KVDevOperation {
  return kvDevOperations.some(operation => operation === value)
}
