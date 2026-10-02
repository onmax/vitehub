/** Vite Development Server route that `vitehub email outbox` commands call. */
export const emailDevRoute = "/__vitehub/email/dev"
/** Nitro route that the dev endpoint forwards outbox operations to. The route exists only in `vite dev`. */
export const emailDevRuntimeRoute = "/_vitehub/email/dev"
export const emailDevHeader = "x-vitehub-email-dev"
export const emailDevHeaderValue = "1"

/** Outbox operations that the dev endpoint accepts. */
export const emailDevOperations = ["list", "get", "clear"] as const

export type EmailDevOperation = typeof emailDevOperations[number]

export interface EmailDevRequestBody {
  id?: string
  operation: EmailDevOperation
}

export function isEmailDevOperation(value: unknown): value is EmailDevOperation {
  return emailDevOperations.some(operation => operation === value)
}
