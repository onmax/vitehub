import { validateViteHubNitroDevRequest } from "@vite-hub/internal/dev-endpoint"
import { redactInspectionText } from "@vite-hub/internal/inspect"

import { peekRateLimit, resetRateLimit } from "../counters.ts"
import { isRateLimitDevOperation, rateLimitDevHeader, rateLimitDevHeaderValue, rateLimitDevRuntimeTokenHeader } from "../dev.ts"

import type { RateLimitPeekInspection, RateLimitResetInspection } from "../counters.ts"
import type { RateLimitDevRequestBody } from "../dev.ts"

function json(value: unknown, status = 200): Response {
  return Response.json(value, { headers: { "cache-control": "no-store" }, status })
}

function failure(message: string, status: number, code?: string): Response {
  return json({ error: { ...(code ? { code } : {}), message } }, status)
}

async function readBody(request: Request): Promise<RateLimitDevRequestBody | undefined> {
  const body: unknown = await request.json().catch(() => undefined)
  if (!body || typeof body !== "object" || Array.isArray(body)) return
  const operation: unknown = Reflect.get(body, "operation")
  const name: unknown = Reflect.get(body, "name")
  const key: unknown = Reflect.get(body, "key")
  if (!isRateLimitDevOperation(operation)) return
  if (typeof name !== "string" || !name.trim() || typeof key !== "string" || !key) return
  return { key, name, operation }
}

/** Removes credentials from the echoed key and from driver error text before the result leaves the runtime. */
function redact<T extends RateLimitPeekInspection | RateLimitResetInspection>(result: T): T {
  return {
    ...result,
    key: redactInspectionText(result.key),
    ...("reason" in result ? { reason: redactInspectionText(result.reason) } : {}),
  }
}

/**
 * Handles one Rate Limit operation from `vitehub rate-limit`. The Vite Development Server forwards the request into
 * the Nitro runtime, so the operation reads the same counters as `requireRateLimit()`.
 *
 * The request must carry the Rate Limit dev header and the private runtime token, must not come from another origin, and must use JSON.
 */
export async function handleRateLimitDevRequest(request: Request, runtimeToken: string): Promise<Response> {
  const rejection = validateViteHubNitroDevRequest(request, { header: rateLimitDevHeader, headerValue: rateLimitDevHeaderValue, label: "Rate Limit Dev" })
  if (rejection) return rejection
  if (!runtimeToken || request.headers.get(rateLimitDevRuntimeTokenHeader) !== runtimeToken) return new Response("Forbidden Rate Limit runtime request.", { status: 403, headers: { "cache-control": "no-store" } })
  const body = await readBody(request)
  if (!body) return failure("The Rate Limit Dev request body is invalid.", 400)
  try {
    return json(redact(body.operation === "peek"
      ? await peekRateLimit(body.name, body.key)
      : await resetRateLimit(body.name, body.key)))
  }
  catch (error) {
    return failure(redactInspectionText(error instanceof Error ? error.message : "The Rate Limit operation failed."), 500)
  }
}
