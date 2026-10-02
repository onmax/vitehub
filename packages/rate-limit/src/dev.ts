/** Vite Development Server route that `vitehub rate-limit` commands call. */
export const rateLimitDevRoute = "/__vitehub/rate-limit/dev"
/** Nitro route that the dev endpoint forwards Rate Limit operations to. The route exists only in `vite dev`. */
export const rateLimitDevRuntimeRoute = "/_vitehub/rate-limit/dev"
export const rateLimitDevHeader = "x-vitehub-rate-limit-dev"
export const rateLimitDevHeaderValue = "1"
/** Private token that the Vite endpoint adds when forwarding into Nitro. */
export const rateLimitDevRuntimeTokenHeader = "x-vitehub-rate-limit-runtime-token"

/** Rate Limit operations that the dev endpoint accepts. */
export const rateLimitDevOperations = ["peek", "reset"] as const

export type RateLimitDevOperation = typeof rateLimitDevOperations[number]

export interface RateLimitDevRequestBody {
  key: string
  name: string
  operation: RateLimitDevOperation
}

export function isRateLimitDevOperation(value: unknown): value is RateLimitDevOperation {
  return rateLimitDevOperations.some(operation => operation === value)
}
