import { registerViteHubDevEndpoint } from "@vite-hub/internal/dev-endpoint"
import { redactInspectionText } from "@vite-hub/internal/inspect"

import { scheduleDevHeader, scheduleDevHeaderValue, scheduleDevRoute, scheduleDevRuntimeRoute } from "./dev.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { ViteHubDevEndpointServer } from "@vite-hub/internal/dev-endpoint"

/** Message that the Schedule dev endpoint returns when the host does not run Nitro in the Vite process. */
export const scheduleDevRuntimeUnavailableMessage = "This Vite Development Server does not run Nitro in process, so it cannot reach the Schedule runtime. `vitehub schedule` commands need a Vite + Nitro host. Nuxt and plain Vite are not supported."

interface FetchableEnvironment {
  dispatchFetch: (request: Request) => Promise<Response>
}

export interface ScheduleDevServer extends ViteHubDevEndpointServer {
  config: ViteHubDevEndpointServer["config"] & { root: string }
  environments?: Record<string, unknown>
}

export interface ScheduleDevEndpointOptions {
  /** Nitro `baseURL`. Nitro routes use this prefix. */
  nitroBaseURL?: () => string | undefined
}

function isFetchableEnvironment(value: unknown): value is FetchableEnvironment {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "dispatchFetch") === "function"
}

function nitroEnvironment(server: ScheduleDevServer): FetchableEnvironment | undefined {
  const environment = server.environments?.nitro
  return isFetchableEnvironment(environment) ? environment : undefined
}

function runtimeRoute(baseURL: string | undefined): string {
  const base = !baseURL || baseURL === "/" ? "" : `/${baseURL.replace(/^\/+|\/+$/g, "")}`
  return `${base}${scheduleDevRuntimeRoute}`
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString("utf8")
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  for (const [name, value] of response.headers) res.setHeader(name, value)
  res.setHeader("cache-control", "no-store")
  const body = await response.arrayBuffer()
  if (body.byteLength) res.write(Buffer.from(body))
  res.end()
}

async function handleScheduleDevEndpoint(
  server: ScheduleDevServer,
  req: IncomingMessage,
  options: ScheduleDevEndpointOptions,
): Promise<Response> {
  const environment = nitroEnvironment(server)
  if (req.method === "GET") {
    return Response.json(environment
      ? { root: server.config.root, runtime: "nitro" }
      : { message: scheduleDevRuntimeUnavailableMessage, root: server.config.root, runtime: "unavailable" })
  }
  if (!environment) {
    return Response.json({ error: { code: "SCHEDULE_DEV_RUNTIME_UNAVAILABLE", message: scheduleDevRuntimeUnavailableMessage } }, { status: 501 })
  }
  // The Nitro runtime owns the Schedule stores and registry. The request runs there, not in a Vite SSR module copy.
  return await environment.dispatchFetch(new Request(`http://localhost${runtimeRoute(options.nitroBaseURL?.())}`, {
    body: await readRequestBody(req),
    headers: {
      "content-type": "application/json",
      [scheduleDevHeader]: scheduleDevHeaderValue,
    },
    method: "POST",
  }))
}

/**
 * Registers the guarded `vitehub schedule` endpoint on a Vite Development Server.
 *
 * `GET` reports the root and whether the Nitro runtime is reachable. `POST` forwards one Schedule operation into the
 * Nitro dev environment. Hosts without an in-process Nitro environment get `501` with a clear message.
 */
export function registerScheduleDevEndpoint(server: ScheduleDevServer, options: ScheduleDevEndpointOptions = {}): void {
  registerViteHubDevEndpoint(server, {
    handle: (req, res) => {
      handleScheduleDevEndpoint(server, req, options)
        .then(response => writeResponse(res, response))
        .catch(error => writeResponse(res, Response.json({
          error: { message: redactInspectionText(`Schedule Dev request failed: ${error instanceof Error ? error.message : String(error)}`) },
        }, { status: 500 })))
    },
    header: scheduleDevHeader,
    headerValue: scheduleDevHeaderValue,
    label: "Schedule Dev",
    methods: ["GET", "POST"],
    route: scheduleDevRoute,
  })
}
