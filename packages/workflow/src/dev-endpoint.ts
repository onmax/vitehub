import { registerViteHubNitroDevEndpoint } from "@vite-hub/internal/dev-endpoint"

import { workflowDevHeader, workflowDevHeaderValue, workflowDevLabel, workflowDevRoute, workflowDevRuntimeRoute } from "./dev-support.ts"

import type { ViteHubNitroDevServer } from "@vite-hub/internal/dev-endpoint"

/** Error code when the host does not run Nitro in the Vite process. */
export const workflowDevRuntimeUnavailableCode = "WORKFLOW_DEV_RUNTIME_UNAVAILABLE"

/** Message that the Workflow dev endpoint returns when the host does not run Nitro in the Vite process. */
export const workflowDevRuntimeUnavailableMessage = "This Vite Development Server does not run Nitro in process, so it cannot reach the Workflow runtime. `vitehub workflow` commands need a Vite + Nitro host. Nuxt and plain Vite are not supported."

export type WorkflowDevServer = ViteHubNitroDevServer

export interface WorkflowDevEndpointOptions {
  /** Nitro `baseURL`. Nitro routes use this prefix. */
  nitroBaseURL?: () => string | undefined
}

/**
 * Registers the guarded `vitehub workflow` endpoint on a Vite Development Server.
 *
 * `GET` reports the root and whether the Nitro runtime is reachable. `POST`
 * forwards one Workflow operation into the Nitro dev environment, because the
 * Nitro runtime owns the Workflow state of the app. Hosts without an
 * in-process Nitro environment get `501` with a clear message.
 */
export function registerWorkflowDevEndpoint(server: WorkflowDevServer, options: WorkflowDevEndpointOptions = {}): void {
  registerViteHubNitroDevEndpoint(server, {
    header: workflowDevHeader,
    headerValue: workflowDevHeaderValue,
    label: workflowDevLabel,
    nitroBaseURL: options.nitroBaseURL,
    route: workflowDevRoute,
    runtimeRoute: workflowDevRuntimeRoute,
    unavailable: { code: workflowDevRuntimeUnavailableCode, message: workflowDevRuntimeUnavailableMessage },
  })
}
