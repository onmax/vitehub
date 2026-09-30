import { connectionError } from "../errors.ts"

import type { ConnectionApiKeyProvider, ConnectionApiKeyVerification, ConnectionProviderContext } from "../types.ts"

export interface ApiKeyProviderOptions {
  /** Request header that carries the key. Default: `authorization`. */
  header?: string
  /** Provider identifier shown in the Console. Default: `"api-key"`. */
  id?: string
  /** Text before the key in the header value. Default: `Bearer` for `authorization`, none for other headers. */
  scheme?: string
  /**
   * Checks a new key before ViteHub stores it, for example with `context.fetch`.
   * Return `false` to reject the key. Return `{ account }` to show an account label in the Console.
   */
  verify?: (key: string, context: ConnectionProviderContext) => Promise<ConnectionApiKeyVerification>
}

// RFC 9110 token characters. Header names and auth schemes use them.
const tokenPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Creates a provider for a static API key. A Console admin sets the key; it is sealed like an OAuth grant. */
export function apiKey(options: ApiKeyProviderOptions = {}): ConnectionApiKeyProvider {
  const header = (options.header ?? "authorization").toLowerCase()
  const scheme = options.scheme ?? (header === "authorization" ? "Bearer" : undefined)
  if (!tokenPattern.test(header) || (scheme !== undefined && !tokenPattern.test(scheme))) {
    throw connectionError("invalid", { path: "provider" })
  }
  return {
    header,
    id: options.id ?? "api-key",
    kind: "api-key",
    scopes: [],
    ...(scheme === undefined ? {} : { scheme }),
    ...(options.verify ? { verify: options.verify } : {}),
  }
}
