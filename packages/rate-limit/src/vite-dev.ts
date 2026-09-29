import { registerViteHubNitroDevEndpoint } from "@vite-hub/internal/dev-endpoint"

import { rateLimitDevHeader, rateLimitDevHeaderValue, rateLimitDevRoute, rateLimitDevRuntimeRoute } from "./dev.ts"

import type { ViteHubNitroDevServer } from "@vite-hub/internal/dev-endpoint"

/** Message that the Rate Limit dev endpoint returns when the host does not run Nitro in the Vite process. */
export const rateLimitDevRuntimeUnavailableMessage = "This Vite Development Server does not run Nitro in process, so it cannot reach the Rate Limit runtime. `vitehub rate-limit` commands need a Vite + Nitro host. Nuxt and plain Vite are not supported."

export interface RateLimitDevEndpointOptions {
  /** Nitro `baseURL`. Nitro routes use this prefix. */
  nitroBaseURL?: () => string | undefined
}

/**
 * Registers the guarded `vitehub rate-limit` endpoint on a Vite Development Server.
 *
 * `GET` reports the root and whether the Nitro runtime is reachable. `POST` forwards one Rate Limit operation into
 * the Nitro dev environment, because the Nitro runtime owns the counters. Hosts without an in-process Nitro
 * environment get `501` with a clear message.
 */
export function registerRateLimitDevEndpoint(server: ViteHubNitroDevServer, options: RateLimitDevEndpointOptions = {}): void {
  registerViteHubNitroDevEndpoint(server, {
    header: rateLimitDevHeader,
    headerValue: rateLimitDevHeaderValue,
    label: "Rate Limit Dev",
    nitroBaseURL: options.nitroBaseURL,
    route: rateLimitDevRoute,
    runtimeRoute: rateLimitDevRuntimeRoute,
    unavailable: { code: "RATE_LIMIT_DEV_RUNTIME_UNAVAILABLE", message: rateLimitDevRuntimeUnavailableMessage },
  })
}
