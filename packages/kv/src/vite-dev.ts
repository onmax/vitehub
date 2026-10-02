import { registerViteHubNitroDevEndpoint } from "@vite-hub/internal/dev-endpoint"

import { kvDevHeader, kvDevHeaderValue, kvDevRoute, kvDevRuntimeRoute } from "./dev.ts"

import type { ViteHubNitroDevServer } from "@vite-hub/internal/dev-endpoint"

/** Message that the KV dev endpoint returns when the host does not run Nitro in the Vite process. */
export const kvDevRuntimeUnavailableMessage = "This Vite Development Server does not run Nitro in process, so it cannot reach the KV runtime. `vitehub kv` commands need a Vite + Nitro host. Nuxt and plain Vite are not supported."

export type KVDevServer = ViteHubNitroDevServer

export interface KVDevEndpointOptions {
  /** Nitro `baseURL`. Nitro routes use this prefix. */
  nitroBaseURL?: () => string | undefined
}

/**
 * Registers the guarded `vitehub kv` endpoint on a Vite Development Server.
 *
 * `GET` reports the root and whether the Nitro runtime is reachable. `POST` forwards one KV operation into the Nitro
 * dev environment, because the Nitro runtime owns the KV stores and their bindings. Hosts without an in-process Nitro
 * environment get `501` with a clear message.
 */
export function registerKVDevEndpoint(server: KVDevServer, options: KVDevEndpointOptions = {}): void {
  registerViteHubNitroDevEndpoint(server, {
    header: kvDevHeader,
    headerValue: kvDevHeaderValue,
    label: "KV Dev",
    nitroBaseURL: options.nitroBaseURL,
    route: kvDevRoute,
    runtimeRoute: kvDevRuntimeRoute,
    unavailable: { code: "KV_DEV_RUNTIME_UNAVAILABLE", message: kvDevRuntimeUnavailableMessage },
  })
}
