import { isViteHubDevRoute, registerViteHubNitroDevEndpoint } from "@vite-hub/internal/dev-endpoint"

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
  const host = server.config.server.host
  if (host === true || (host && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host))) {
    throw new Error("[vitehub] Rate Limit dev commands require a loopback-only Vite server. Set server.host to localhost, 127.0.0.1, or ::1.")
  }
  const guardedServer: ViteHubNitroDevServer = {
    config: server.config,
    get environments() { return server.environments },
    get resolvedUrls() { return server.resolvedUrls },
    middlewares: {
      use: handler => server.middlewares.use((req, res, next) => {
        const peer = req.socket?.remoteAddress
        const loopback = peer === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(peer ?? "") || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(peer ?? "")
        if (isViteHubDevRoute(req, rateLimitDevRoute) && !loopback) {
          res.statusCode = 403
          res.setHeader("cache-control", "no-store")
          res.end("Rate Limit Dev requests require a loopback peer.")
          return
        }
        handler(req, res, next)
      }),
    },
  }
  registerViteHubNitroDevEndpoint(guardedServer, {
    header: rateLimitDevHeader,
    headerValue: rateLimitDevHeaderValue,
    label: "Rate Limit Dev",
    nitroBaseURL: options.nitroBaseURL,
    route: rateLimitDevRoute,
    runtimeRoute: rateLimitDevRuntimeRoute,
    unavailable: { code: "RATE_LIMIT_DEV_RUNTIME_UNAVAILABLE", message: rateLimitDevRuntimeUnavailableMessage },
  })
}
