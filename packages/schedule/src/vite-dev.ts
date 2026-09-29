import { registerViteHubNitroDevEndpoint } from "@vite-hub/internal/dev-endpoint"

import { scheduleDevHeader, scheduleDevHeaderValue, scheduleDevRoute, scheduleDevRuntimeRoute } from "./dev.ts"

import type { ViteHubNitroDevServer } from "@vite-hub/internal/dev-endpoint"

/** Message that the Schedule dev endpoint returns when the host does not run Nitro in the Vite process. */
export const scheduleDevRuntimeUnavailableMessage = "This Vite Development Server does not run Nitro in process, so it cannot reach the Schedule runtime. `vitehub schedule` commands need a Vite + Nitro host. Nuxt and plain Vite are not supported."

export type ScheduleDevServer = ViteHubNitroDevServer

export interface ScheduleDevEndpointOptions {
  /** Nitro `baseURL`. Nitro routes use this prefix. */
  nitroBaseURL?: () => string | undefined
}

/**
 * Registers the guarded `vitehub schedule` endpoint on a Vite Development Server.
 *
 * `GET` reports the root and whether the Nitro runtime is reachable. `POST` forwards one Schedule operation into the
 * Nitro dev environment, because the Nitro runtime owns the Schedule stores and registry. Hosts without an in-process
 * Nitro environment get `501` with a clear message.
 */
export function registerScheduleDevEndpoint(server: ScheduleDevServer, options: ScheduleDevEndpointOptions = {}): void {
  registerViteHubNitroDevEndpoint(server, {
    header: scheduleDevHeader,
    headerValue: scheduleDevHeaderValue,
    label: "Schedule Dev",
    nitroBaseURL: options.nitroBaseURL,
    route: scheduleDevRoute,
    runtimeRoute: scheduleDevRuntimeRoute,
    unavailable: { code: "SCHEDULE_DEV_RUNTIME_UNAVAILABLE", message: scheduleDevRuntimeUnavailableMessage },
  })
}
