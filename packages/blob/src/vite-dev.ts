import { registerViteHubNitroDevEndpoint } from "@vite-hub/internal/dev-endpoint"

import { blobDevHeader, blobDevHeaderValue, blobDevRoute, blobDevRuntimeRoute } from "./dev.ts"

import type { ViteHubNitroDevServer } from "@vite-hub/internal/dev-endpoint"

/** Message that the Blob dev endpoint returns when the host does not run Nitro in the Vite process. */
export const blobDevRuntimeUnavailableMessage = "This Vite Development Server does not run Nitro in process, so it cannot reach the Blob runtime. `vitehub blob` commands need a Vite + Nitro host. Nuxt and plain Vite are not supported."

export type BlobDevServer = ViteHubNitroDevServer

export interface BlobDevEndpointOptions {
  /** Nitro `baseURL`. Nitro routes use this prefix. */
  nitroBaseURL?: () => string | undefined
  discovery?: () => Record<string, unknown>
  forwardHeaders?: readonly string[]
}

/**
 * Registers the guarded `vitehub blob` endpoint on a Vite Development Server.
 *
 * `GET` reports the root and whether the Nitro runtime is reachable. `POST` forwards one Blob operation into the
 * Nitro dev environment, because the Nitro runtime owns the Blob stores and their bindings. Hosts without an
 * in-process Nitro environment get `501` with a clear message.
 */
export function registerBlobDevEndpoint(server: BlobDevServer, options: BlobDevEndpointOptions = {}): void {
  registerViteHubNitroDevEndpoint(server, {
    header: blobDevHeader,
    headerValue: blobDevHeaderValue,
    label: "Blob Dev",
    discovery: options.discovery?.(),
    forwardHeaders: options.forwardHeaders,
    nitroBaseURL: options.nitroBaseURL,
    route: blobDevRoute,
    runtimeRoute: blobDevRuntimeRoute,
    unavailable: { code: "BLOB_DEV_RUNTIME_UNAVAILABLE", message: blobDevRuntimeUnavailableMessage },
  })
}
