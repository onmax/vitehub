import { encodeRouteSegment } from "./route-segment.ts"

/** Public origins resolved from `vitehub({ publicUrl })` at build time. */
export interface PublicUrlConfig {
  /** One origin for the whole deployment. */
  url?: string
  /** One origin per discovered Agent, from the function form. */
  agents?: Record<string, string>
}

declare const __VITEHUB_PUBLIC_URL__: PublicUrlConfig | undefined
declare const __VITEHUB_APP_BASE_URL__: string | undefined

function publicUrlConfig(): PublicUrlConfig {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The build injects this value only when `vitehub({ publicUrl })` is set.
  return typeof __VITEHUB_PUBLIC_URL__ === "undefined" ? {} : __VITEHUB_PUBLIC_URL__
}

function applicationBasePath(): string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The injected host base is optional in standalone package consumers.
  const configured = typeof __VITEHUB_APP_BASE_URL__ === "undefined" ? "/" : __VITEHUB_APP_BASE_URL__
  const segments = configured.split("/").filter(Boolean)
  return segments.length ? `/${segments.join("/")}` : ""
}

/**
 * Resolve the public origin of this deployment.
 *
 * Order: the Agent's origin from `vitehub({ publicUrl })`, the single configured
 * origin, the configured origin with the same host as the request, and then the
 * request origin. Returns `undefined` when nothing is configured and no request exists.
 */
export function resolvePublicUrl(options: { agentName?: string, request: Pick<Request, "url"> }): string
export function resolvePublicUrl(options?: { agentName?: string, request?: Pick<Request, "url"> }): string | undefined
export function resolvePublicUrl(options: { agentName?: string, request?: Pick<Request, "url"> } = {}): string | undefined {
  const config = publicUrlConfig()
  const agentUrl = options.agentName ? config.agents?.[options.agentName] : undefined
  if (agentUrl) return agentUrl
  if (config.url) return config.url
  if (!options.request) return
  const request = new URL(options.request.url)
  return Object.values(config.agents ?? {}).find(url => new URL(url).host === request.host) ?? request.origin
}

/** Build the Console URL of one Agent invocation. `origin` must not include the application base path. */
export function consoleInvocationUrl(origin: string, agentName: string, invocationId: string): string {
  const path = `${applicationBasePath()}/_vitehub/agents/${encodeRouteSegment(agentName)}/invocations/${encodeURIComponent(invocationId)}`
  return new URL(path, origin).href
}
