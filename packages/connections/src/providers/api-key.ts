import { connectionError } from "../errors.ts"
import { assertConnectionOrigins, assertConnectionProviderId } from "../origins.ts"

import type { ConnectionApiKeyProvider, ConnectionApiKeyVerification, ConnectionProviderContext } from "../types.ts"

export interface ApiKeyProviderOptions {
  /** Request header that carries the key. Default: `authorization`. */
  header?: string
  /** Provider identifier shown in the Console. It cannot contain `:`. Default: `"api-key"`. */
  id?: string
  /** API origins that may receive the key, for example `["https://api.example.com"]`. Calls to other origins fail. */
  origins: readonly string[]
  /**
   * Text before the key in the header value. Default: `Bearer` for `authorization`, none for other headers.
   * Set `""` to send the bare key, for example `Authorization: <key>`.
   */
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
export function apiKey(options: ApiKeyProviderOptions): ConnectionApiKeyProvider {
  const header = (options.header ?? "authorization").toLowerCase()
  const scheme = options.scheme === "" ? undefined : options.scheme ?? (header === "authorization" ? "Bearer" : undefined)
  if (!tokenPattern.test(header) || (scheme !== undefined && !tokenPattern.test(scheme))) {
    throw connectionError("invalid", { path: "provider" })
  }
  const origins = assertConnectionOrigins(options.origins)
  return {
    header,
    id: assertConnectionProviderId(options.id ?? "api-key"),
    kind: "api-key",
    origins,
    scopes: [],
    ...(scheme === undefined ? {} : { scheme }),
    ...(options.verify ? { verify: options.verify } : {}),
  }
}
