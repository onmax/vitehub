/** Whether an Operation only reads provider state or changes it. */
export type ConnectionEffect = "read" | "write"

/** Who uses a Connection. Routes use `"METHOD /pattern"`. Agents use their Agent name. */
export interface ConnectionActor {
  id: string
  kind: "agent" | "route" | "schedule" | "service" | "user"
}

/** Result of an access check. */
export type ConnectionAccessDecision = "allow" | "deny" | "require-approval"

/**
 * Operation patterns for one actor. `*` matches any characters, including dots.
 * Deny wins, then approve, then allow. Without a match, reads are allowed and writes are denied.
 */
export interface ConnectionAccessRule {
  allow?: readonly string[]
  approve?: readonly string[]
  deny?: readonly string[]
}

export interface ConnectionAccess {
  /** Agents by Agent name. */
  agents?: Readonly<Record<string, ConnectionAccessRule>>
  /** Server routes by `"METHOD /pattern"`. Falls back to `server`. */
  routes?: Readonly<Record<string, ConnectionAccessRule>>
  /** Server code, schedules, routes without their own rule, and Console users. */
  server?: ConnectionAccessRule
}

/** A secret value such as `SecretEnv`, or a plain string. */
export type ConnectionSecret = string | { unseal(): string }

export interface ConnectionOAuthClient {
  clientId: string
  clientSecret?: ConnectionSecret
}

/** Token set kept sealed in the database. It never leaves the server runtime. */
export interface ConnectionTokenSet {
  accessToken: string
  account?: string
  expiresAt?: number
  refreshToken?: string
  scopes: readonly string[]
  tokenType: string
}

export interface ConnectionAuthorizationInput {
  codeChallenge: string
  redirectUri: string
  state: string
}

export interface ConnectionExchangeInput {
  code: string
  codeVerifier: string
  redirectUri: string
}

/** Runtime values that a provider receives for each request. */
export interface ConnectionProviderContext {
  /** H3 event of the current request, when there is one. */
  event?: unknown
  fetch: typeof globalThis.fetch
  /** Cancels provider work for the current Operation. The supplied fetch also uses this signal. */
  signal?: AbortSignal
}

interface ConnectionProviderBase {
  /** Provider identifier shown in the Console. */
  id: string
  /**
   * API origins that may receive the credential, for example `https://api.example.com` or `https://*.example.com`.
   * Calls to any other origin fail before ViteHub attaches the credential.
   */
  origins: readonly string[]
  revoke?: (token: ConnectionTokenSet, context: ConnectionProviderContext) => Promise<void>
  scopes: readonly string[]
}

/** OAuth 2 authorization code provider with PKCE. The Console starts the consent flow. */
export interface ConnectionOAuth2Provider extends ConnectionProviderBase {
  authorizationUrl: (input: ConnectionAuthorizationInput, context: ConnectionProviderContext) => Promise<string>
  exchange: (input: ConnectionExchangeInput, context: ConnectionProviderContext) => Promise<ConnectionTokenSet>
  kind: "oauth2"
  refresh: (token: ConnectionTokenSet, context: ConnectionProviderContext) => Promise<ConnectionTokenSet>
}

/** Result of an API key check. `false` rejects the key. */
export type ConnectionApiKeyVerification = false | { account?: string }

/** API key provider. A Console admin sets the key. ViteHub sends it in one request header. */
export interface ConnectionApiKeyProvider extends ConnectionProviderBase {
  /** Lowercase request header that carries the key. */
  header: string
  kind: "api-key"
  /** Text before the key in the header value, for example `Bearer`. */
  scheme?: string
  /** Checks a new key before ViteHub stores it. */
  verify?: (key: string, context: ConnectionProviderContext) => Promise<ConnectionApiKeyVerification>
}

/** Provider contract. v1 supports OAuth 2 with PKCE and API keys. */
export type ConnectionProvider = ConnectionApiKeyProvider | ConnectionOAuth2Provider

/** How the Connection gets its credential. */
export type ConnectionKind = ConnectionProvider["kind"]

export interface ConnectionDefinition<TProvider extends ConnectionProvider = ConnectionProvider> {
  access?: ConnectionAccess
  description?: string
  provider: TProvider
}

export type ConnectionDefinitionRegistry = Record<string, () => Promise<unknown>>

export interface DiscoveredConnectionDefinition {
  handler: string
  name: string
  source: "server-connections"
}

export interface ConnectionRequest {
  body?: unknown
  headers?: Record<string, string>
  method: "DELETE" | "GET" | "HEAD" | "PATCH" | "POST" | "PUT"
  query?: Record<string, boolean | number | readonly string[] | string | undefined>
  url: string
}

/** One typed provider call. The id is matched by access patterns. */
export interface ConnectionOperation<TInput = unknown, TOutput = unknown, TEffect extends ConnectionEffect = ConnectionEffect> {
  effect: TEffect
  id: string
  request: (input: TInput) => ConnectionRequest
  scopes?: readonly string[]
  /** Maps the parsed JSON body to the output. */
  parse?: (body: unknown) => TOutput
}

/** Result of a write Operation that dry run skipped. */
export interface ConnectionSkipped {
  operation: string
  skipped: "dry-run"
}

export type ConnectionCallResult<TOutput, TEffect extends ConnectionEffect, TDryRun extends boolean | undefined>
  = TEffect extends "write"
    ? TDryRun extends true ? ConnectionSkipped : TDryRun extends false | undefined ? TOutput : TOutput | ConnectionSkipped
    : TOutput

/** Trace fields that link activity to an Agent Invocation. */
export interface ConnectionTrace {
  invocationId?: string
  runId?: string
  tool?: string
  traceId?: string
}

export interface UseConnectionOptions<TDryRun extends boolean | undefined = boolean | undefined> {
  /** Overrides the actor. By default the actor comes from `event`, or is the server. */
  actor?: ConnectionActor
  /** `"all"` records reads too. Agent Capabilities use it. Default: writes, denials, and failures. */
  audit?: "all" | "changes"
  /** Skips write Operations and records them as skipped. */
  dryRun?: TDryRun
  /** H3 event of the current request. Used for the route actor and host env. */
  event?: unknown
  trace?: ConnectionTrace
}

export type ConnectionStatus = "active" | "disconnected" | "error" | "needs-reconnect"

export interface ConnectionSummary {
  access: ConnectionAccess
  account?: string
  connectedAt?: string
  description?: string
  expiresAt?: string
  /** Request header that carries the key of an API key Connection. */
  header?: string
  kind: ConnectionKind
  lastError?: string
  name: string
  /** API origins that may receive the credential. */
  origins: readonly string[]
  provider: string
  scopes: readonly string[]
  status: ConnectionStatus
  updatedAt?: string
}

export type ConnectionActivityAction = "call" | "connect" | "disconnect" | "refresh"
export type ConnectionActivityOutcome = "approval-required" | "denied" | "failed" | "skipped" | "succeeded"

/** Durable activity. It has no request or response bodies, and no headers. */
export interface ConnectionActivity extends ConnectionTrace {
  action: ConnectionActivityAction
  actor: ConnectionActor
  connection: string
  durationMs?: number
  effect?: ConnectionEffect
  error?: string
  id: string
  operation?: string
  outcome: ConnectionActivityOutcome
  status?: number
  /** Host and path of the provider request, without the query. */
  target?: string
  timestamp: string
}

export interface ConnectionClient<TDryRun extends boolean | undefined = boolean | undefined> {
  /** Runs a typed Operation with access checks, refresh, dry run, and audit. */
  call: <TInput, TOutput, TEffect extends ConnectionEffect>(
    operation: ConnectionOperation<TInput, TOutput, TEffect>,
    input: TInput,
  ) => Promise<ConnectionCallResult<TOutput, TEffect, TDryRun>>
  /** Authenticated fetch. GET and HEAD are reads. Other methods are writes. */
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>
  readonly name: string
  status: () => Promise<ConnectionSummary>
}

/** Generated `#vitehub/connections/runtime` module. */
export interface ConnectionsRuntimeModule {
  database: () => { all: (query: import("drizzle-orm").SQL) => unknown[] | PromiseLike<unknown[]>, run: (query: import("drizzle-orm").SQL) => unknown } | undefined
  encryptionKey: (event: unknown) => string | Uint8Array | undefined
  registry: ConnectionDefinitionRegistry
}
