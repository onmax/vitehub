import { connectionError } from "./errors.ts"

// `https://api.example.com`, `https://*.example.com`, or `http://localhost:8787`. No path, query, or credentials.
const originPattern = /^(https?):\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/i

/** Checks provider origins when the provider is created. */
export function assertConnectionOrigins(origins: unknown, path = "provider.origins"): readonly string[] {
  if (!Array.isArray(origins) || !origins.length || origins.some(origin => !originPattern.test(String(origin)))) {
    throw connectionError("invalid", { path })
  }
  return origins.map(origin => String(origin).toLowerCase())
}

/** Whether `url` is one of the origins. `*.` matches one or more subdomain labels, not the bare domain. */
export function matchesConnectionOrigin(origins: readonly string[], url: URL): boolean {
  return origins.some((origin) => {
    const match = originPattern.exec(origin)
    if (!match) return false
    const [, protocol, wildcard, host, port] = match
    if (url.protocol !== `${protocol}:` || url.port !== (port ?? "")) return false
    const hostname = url.hostname.toLowerCase()
    return wildcard ? hostname.endsWith(`.${host}`) : hostname === host
  })
}
