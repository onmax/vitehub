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
  config: { server: { port?: number } }
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
 * Checks the guard header, the request origin, and the JSON content type of `POST` requests.
 * Returns the rejection response, or `undefined` when the request can continue.
 */
export function validateViteHubDevRequest(
  server: Pick<ViteHubDevEndpointServer, "config" | "resolvedUrls">,
  req: IncomingMessage,
  guard: ViteHubDevEndpointGuard,
): Response | undefined {
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

async function writeRejection(res: ServerResponse, response: Response): Promise<void> {
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
      void writeRejection(res, new Response("Method not allowed.", { status: 405 }))
      return
    }
    const blocked = validateViteHubDevRequest(server, req, options)
    if (blocked) {
      void writeRejection(res, blocked)
      return
    }
    options.handle(req, res)
  })
}
