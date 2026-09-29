import { registerViteHubNitroDevEndpoint } from "@vite-hub/internal/dev-endpoint"

import { emailDevHeader, emailDevHeaderValue, emailDevRoute, emailDevRuntimeRoute } from "./dev.ts"

import type { ViteHubNitroDevServer } from "@vite-hub/internal/dev-endpoint"

/** Message that the Email dev endpoint returns when the host does not run Nitro in the Vite process. */
export const emailDevRuntimeUnavailableMessage = "This Vite Development Server does not run Nitro in process, so it cannot reach the Email outbox. `vitehub email outbox` commands need a Vite + Nitro host. Nuxt and plain Vite are not supported."

export interface EmailDevEndpointOptions {
  /** Nitro `baseURL`. Nitro routes use this prefix. */
  nitroBaseURL?: () => string | undefined
}

/**
 * Registers the guarded `vitehub email outbox` endpoint on a Vite Development Server.
 *
 * `GET` reports the root and whether the Nitro runtime is reachable. `POST` forwards one outbox operation into the
 * Nitro dev environment, because the server runtime owns the outbox. Hosts without an in-process Nitro environment
 * get `501` with a clear message.
 */
export function registerEmailDevEndpoint(server: ViteHubNitroDevServer, options: EmailDevEndpointOptions = {}): void {
  registerViteHubNitroDevEndpoint(server, {
    header: emailDevHeader,
    headerValue: emailDevHeaderValue,
    label: "Email Dev",
    nitroBaseURL: options.nitroBaseURL,
    route: emailDevRoute,
    runtimeRoute: emailDevRuntimeRoute,
    unavailable: { code: "EMAIL_DEV_RUNTIME_UNAVAILABLE", message: emailDevRuntimeUnavailableMessage },
  })
}
