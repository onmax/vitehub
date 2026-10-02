import { redactInspectionText } from "./inspect.ts"

import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * Guard that a dev endpoint requires on each request.
 *
 * `label` names the endpoint in rejection messages, for example
 * `Forbidden Workspace Dev request.`.
 */
export interface ViteHubDevEndpointGuard {
  header: string
  headerValue: string
  label: string
}

/**
 * Parts of a Vite development server that dev endpoints use.
 */
export interface ViteHubDevEndpointServer {
  config: {
    server: {
      /** Host names that Vite accepts in the `Host` header. `true` accepts all hosts. */
      allowedHosts?: readonly string[] | true
      /** Host that the dev server listens on. A string host is also an allowed host. */
      host?: string | boolean
      /** When set, Vite does not check the `Host` header, because TLS binds the host name. */
      https?: unknown
      port?: number
    }
  }
  middlewares: {
    use: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => unknown
  }
  resolvedUrls?: { local?: readonly string[] } | null
}

export interface ViteHubDevEndpointOptions extends ViteHubDevEndpointGuard {
  /**
   * Handles a request that passed the route, method, and guard checks.
   * The handler writes the response.
   */
  handle: (req: IncomingMessage, res: ServerResponse) => void
  /**
   * Methods that the endpoint accepts. Other methods get `405` before the guard runs.
   * When omitted, the handler checks the method.
   */
  methods?: readonly string[]
  route: string
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

const ipv4Octet = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)"
const ipv4Literal = new RegExp(`^${ipv4Octet}(?:\\.${ipv4Octet}){3}$`)

/**
 * Tests IP literals like `node:net` `isIP`, without a Node import, so the Nitro-side check also runs in Worker
 * runtimes. IPv4 uses the Node pattern (dotted decimal, no leading zeros). IPv6 uses the WHATWG URL parser, which
 * rejects zone IDs. Browsers do not send zone IDs in `Host`.
 */
function isIPv4Literal(value: string): boolean {
  return ipv4Literal.test(value)
}

function isIPv6Literal(value: string): boolean {
  if (!value.includes(":") || !/^[\d.:a-f]+$/i.test(value)) return false
  try {
    return new URL(`http://[${value}]/`).hostname !== ""
  }
  catch {
    return false
  }
}

function hostHeaderAllowed(host: string, allowedHosts: readonly string[]): boolean {
  const trimmed = host.trim().toLowerCase()
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]")
    return end > 0 && isIPv6Literal(trimmed.slice(1, end))
  }
  const colon = trimmed.indexOf(":")
  const hostname = colon === -1 ? trimmed : trimmed.slice(0, colon)
  if (isIPv4Literal(hostname)) return true
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true
  return allowedHosts.some(value => {
    const allowed = value.toLowerCase()
    return allowed === hostname
      || (allowed.startsWith(".") && (allowed.slice(1) === hostname || hostname.endsWith(allowed)))
  })
}

/**
 * Checks the `Host` header with the same rules as Vite's host validation.
 *
 * Accepts a missing header, IP literals, `localhost`, `*.localhost`, the configured
 * `server.host`, and `server.allowedHosts`. An entry that starts with `.` also accepts
 * its subdomains. `allowedHosts: true` or `server.https` accepts all hosts, as in Vite.
 *
 * Dev endpoints run this check themselves, so they do not depend on the host
 * framework to run Vite's host validation before them. This blocks DNS rebinding:
 * a page on a rebound host name sends a matching `Origin`, but its `Host` is not allowed.
 */
export function isViteHubDevHostAllowed(server: Pick<ViteHubDevEndpointServer, "config">, req: IncomingMessage): boolean {
  const host = firstHeader(req.headers.host)
  if (host === undefined) return true
  const { allowedHosts = [], host: listenHost, https } = server.config.server
  if (allowedHosts === true || https) return true
  if (listenHost === undefined || listenHost === true || listenHost === false) return hostHeaderAllowed(host, allowedHosts)
  return hostHeaderAllowed(host, [...allowedHosts, listenHost])
}

/**
 * Origin that the dev server serves the request on. Browser requests from other origins are rejected.
 */
export function viteHubDevRequestOrigin(server: Pick<ViteHubDevEndpointServer, "config" | "resolvedUrls">, req: IncomingMessage): string {
  const host = firstHeader(req.headers.host)
  if (host) {
    const fallback = server.resolvedUrls?.local?.[0] || "http://localhost/"
    return new URL(`${new URL(fallback).protocol}//${host}`).origin
  }
  const base = server.resolvedUrls?.local?.[0] || `http://localhost:${server.config.server.port || 5173}/`
  return new URL(base).origin
}

/**
 * Checks the `Host` header, the guard header, the request origin, and the JSON content
 * type of `POST` requests. Returns the rejection response, or `undefined` when the
 * request can continue.
 */
export function validateViteHubDevRequest(
  server: Pick<ViteHubDevEndpointServer, "config" | "resolvedUrls">,
  req: IncomingMessage,
  guard: ViteHubDevEndpointGuard,
): Response | undefined {
  if (!isViteHubDevHostAllowed(server, req)) {
    return new Response(`Forbidden ${guard.label} host.`, { status: 403 })
  }
  if (firstHeader(req.headers[guard.header]) !== guard.headerValue) {
    return new Response(`Forbidden ${guard.label} request.`, { status: 403 })
  }
  const origin = firstHeader(req.headers.origin)
  if (origin && origin !== viteHubDevRequestOrigin(server, req)) {
    return new Response(`Forbidden ${guard.label} origin.`, { status: 403 })
  }
  if (req.method !== "POST") return
  const contentType = firstHeader(req.headers["content-type"])
  if (!contentType?.toLowerCase().startsWith("application/json")) {
    return new Response(`${guard.label} requests must use application/json.`, { status: 415 })
  }
}

export function isViteHubDevRoute(req: IncomingMessage, route: string): boolean {
  return new URL(req.url || "/", "http://localhost").pathname === route
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  for (const [name, value] of response.headers) res.setHeader(name, value)
  const body = await response.arrayBuffer()
  if (body.byteLength) res.write(Buffer.from(body))
  res.end()
}

/**
 * Registers a guarded dev endpoint on a Vite development server.
 *
 * The middleware skips other routes, rejects methods outside `methods`, and
 * runs {@link validateViteHubDevRequest} before it calls `handle`. Dev
 * endpoints exist only on the development server. They are not an
 * authenticated path to a deployed stage.
 */
export function registerViteHubDevEndpoint(server: ViteHubDevEndpointServer, options: ViteHubDevEndpointOptions): void {
  server.middlewares.use((req, res, next) => {
    if (!isViteHubDevRoute(req, options.route)) {
      next()
      return
    }
    if (options.methods && !options.methods.includes(req.method || "")) {
      void writeResponse(res, new Response("Method not allowed.", { status: 405 }))
      return
    }
    const blocked = validateViteHubDevRequest(server, req, options)
    if (blocked) {
      void writeResponse(res, blocked)
      return
    }
    options.handle(req, res)
  })
}

/**
 * Nitro dev environment of a Vite + Nitro Development Server. Nitro registers it as `server.environments.nitro`.
 * `dispatchFetch` runs a request in the Nitro runtime, so it uses the same stores and registries as the application.
 */
export interface ViteHubNitroDevEnvironment {
  dispatchFetch: (request: Request) => Promise<Response>
}

/**
 * Parts of a Vite development server that Nitro dev forwarding uses.
 */
export interface ViteHubNitroDevServer extends ViteHubDevEndpointServer {
  config: ViteHubDevEndpointServer["config"] & { root: string }
  environments?: Record<string, unknown>
}

export interface ViteHubNitroDevForwardOptions extends ViteHubDevEndpointGuard {
  /** Additional authenticated headers to forward into the Nitro handler. */
  forwardHeaders?: readonly string[]
  /** Nitro `baseURL`. Nitro routes use this prefix. Read on each request. */
  nitroBaseURL?: () => string | undefined
  /** Nitro route of the dev-only handler, for example `/_vitehub/schedule/dev`. */
  runtimeRoute: string
  /** Error code and message of the `501` response when the Vite process has no Nitro environment. */
  unavailable?: { code?: string, message?: string }
}

export interface ViteHubNitroDevEndpointOptions extends ViteHubNitroDevForwardOptions {
  /** Owner authorization before POST bodies are read or forwarded. */
  authorize?: (request: IncomingMessage) => Promise<Response | undefined>
  /** Public discovery metadata. Never include credentials. */
  discovery?: Record<string, unknown>
  /** Vite Development Server route that the CLI calls, for example `/__vitehub/schedule/dev`. */
  route: string
}

/** Default error code of the `501` response. */
export const viteHubNitroDevUnavailableCode = "VITEHUB_NITRO_DEV_RUNTIME_UNAVAILABLE"

/**
 * Default message when the Vite process has no Nitro environment. Nuxt runs Nitro outside the Vite middleware, and
 * plain Vite has no Nitro.
 */
export function viteHubNitroDevUnavailableMessage(label: string): string {
  return `This Vite Development Server does not run Nitro in process, so the ${label} endpoint cannot reach the server runtime. Use a Vite + Nitro host. Nuxt and plain Vite are not supported.`
}

function isNitroDevEnvironment(value: unknown): value is ViteHubNitroDevEnvironment {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Nitro exposes opaque Vite environments; a callable dispatchFetch is its dev dispatch contract.
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "dispatchFetch") === "function"
}

/** Returns the in-process Nitro dev environment, or `undefined` when the host does not run Nitro in the Vite process. */
export function findViteHubNitroDevEnvironment(server: Pick<ViteHubNitroDevServer, "environments">): ViteHubNitroDevEnvironment | undefined {
  const environment = server.environments?.nitro
  return isNitroDevEnvironment(environment) ? environment : undefined
}

/** Prefixes a Nitro route with the Nitro `baseURL`. */
export function viteHubNitroRuntimeRoute(route: string, baseURL?: string): string {
  const base = !baseURL || baseURL === "/" ? "" : `/${baseURL.replace(/^\/+|\/+$/g, "")}`
  return `${base}${route}`
}

function unavailableResponse(options: ViteHubNitroDevForwardOptions): Response {
  return Response.json({
    error: {
      code: options.unavailable?.code ?? viteHubNitroDevUnavailableCode,
      message: options.unavailable?.message ?? viteHubNitroDevUnavailableMessage(options.label),
    },
  }, { status: 501 })
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * Forwards a guarded `POST` from the Vite middleware into the Nitro dev environment.
 *
 * The request goes to `runtimeRoute` under the Nitro `baseURL`, with the JSON body, the JSON content type, and the
 * guard header. The Nitro handler must check the request again with {@link validateViteHubNitroDevRequest}. Returns
 * `501` with a clear message when the Vite process has no Nitro environment.
 */
export async function forwardViteHubDevRequestToNitro(
  server: Pick<ViteHubNitroDevServer, "environments">,
  req: IncomingMessage,
  options: ViteHubNitroDevForwardOptions,
): Promise<Response> {
  const environment = findViteHubNitroDevEnvironment(server)
  if (!environment) return unavailableResponse(options)
  return await environment.dispatchFetch(new Request(`http://localhost${viteHubNitroRuntimeRoute(options.runtimeRoute, options.nitroBaseURL?.())}`, {
    body: await readRequestBody(req),
    headers: {
      "content-type": "application/json", [options.header]: options.headerValue,
      ...Object.fromEntries((options.forwardHeaders ?? []).flatMap(name => {
        const value = firstHeader(req.headers[name])
        return value === undefined ? [] : [[name, value]]
      })),
    },
    method: "POST",
  }))
}

/**
 * Registers a guarded dev endpoint that runs its operations in the Nitro dev environment.
 *
 * `GET` returns `{ root, runtime: "nitro" }`, or `{ message, root, runtime: "unavailable" }` when the Vite process has
 * no Nitro environment. `POST` goes through {@link forwardViteHubDevRequestToNitro}. Responses use
 * `cache-control: no-store`, and forwarding errors return `500` with credentials redacted.
 */
export function registerViteHubNitroDevEndpoint(server: ViteHubNitroDevServer, options: ViteHubNitroDevEndpointOptions): void {
  const respond = async (req: IncomingMessage): Promise<Response> => {
    if (req.method === "GET") {
      return Response.json(findViteHubNitroDevEnvironment(server)
        ? { root: server.config.root, runtime: "nitro", ...options.discovery }
        : { message: options.unavailable?.message ?? viteHubNitroDevUnavailableMessage(options.label), root: server.config.root, runtime: "unavailable", ...options.discovery })
    }
    const rejected = await options.authorize?.(req)
    if (rejected) return rejected
    return await forwardViteHubDevRequestToNitro(server, req, options)
  }
  const write = (res: ServerResponse, response: Response) => {
    res.setHeader("cache-control", "no-store")
    return writeResponse(res, response)
  }
  registerViteHubDevEndpoint(server, {
    handle: (req, res) => {
      respond(req)
        .then(response => write(res, response))
        .catch(error => write(res, Response.json({
          error: { message: redactInspectionText(`${options.label} request failed: ${error instanceof Error ? error.message : String(error)}`) },
        }, { status: 500 })))
    },
    header: options.header,
    headerValue: options.headerValue,
    label: options.label,
    methods: ["GET", "POST"],
    route: options.route,
  })
}

/**
 * Checks the host of a request that reaches the Nitro dev handler.
 *
 * {@link forwardViteHubDevRequestToNitro} always calls `http://localhost`, so a forwarded request passes. The Nitro
 * route is also reachable over HTTP on the dev server, and the Nitro runtime does not know `server.allowedHosts`.
 * This check therefore accepts only `localhost`, `*.localhost`, and IP literals in the request URL and in the `Host`
 * header. A DNS rebinding page uses another host name, so it gets `403`.
 */
export function isViteHubNitroDevHostAllowed(request: Request): boolean {
  const host = request.headers.get("host")
  return hostHeaderAllowed(new URL(request.url).host, []) && (host === null || hostHeaderAllowed(host, []))
}

/**
 * Checks a request inside the Nitro dev handler: the host, the guard header, the request origin, `POST`, and the JSON
 * content type. Returns the rejection response, or `undefined` when the request can continue. The Nitro route exists
 * only in `vite dev`, but it is reachable on the dev server origin, so it checks the same guard as the Vite endpoint.
 */
export function validateViteHubNitroDevRequest(request: Request, guard: ViteHubDevEndpointGuard): Response | undefined {
  if (!isViteHubNitroDevHostAllowed(request)) {
    return new Response(`Forbidden ${guard.label} host.`, { status: 403 })
  }
  if (request.headers.get(guard.header) !== guard.headerValue) {
    return new Response(`Forbidden ${guard.label} request.`, { status: 403 })
  }
  const origin = request.headers.get("origin")
  if (origin && origin !== new URL(request.url).origin) {
    return new Response(`Forbidden ${guard.label} origin.`, { status: 403 })
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed.", { headers: { allow: "POST" }, status: 405 })
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return new Response(`${guard.label} requests must use application/json.`, { status: 415 })
  }
}

export interface ViteHubNitroDevHandlerSource {
  /** Public owner context, for example a project path. Never include credentials. */
  context?: Record<string, unknown>
  /** Named export of `module` that takes a Fetch `Request` and returns a `Response`. */
  export: string
  /** Module that the generated handler imports, for example `vite-hub/_internal/schedule/runtime/console`. */
  module: string
}

/**
 * Renders the source of a dev-only Nitro handler that passes the request to an owner package export. Add the file with
 * `addHandler` only in `serve` mode, so build output never contains it.
 */
export function renderViteHubNitroDevHandler(source: ViteHubNitroDevHandlerSource): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(source.export)) {
    throw new TypeError(`[vitehub] Nitro dev handler export ${JSON.stringify(source.export)} must be an identifier.`)
  }
  return [
    "import { defineEventHandler } from 'h3'",
    `import { ${source.export} as handleViteHubDevRequest } from ${JSON.stringify(source.module)}`,
    "",
    `export default defineEventHandler(event => handleViteHubDevRequest(event.req${source.context ? `, ${JSON.stringify(source.context)}` : ""}))`,
    "",
  ].join("\n")
}
