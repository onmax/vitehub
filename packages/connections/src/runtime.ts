import { ConnectionError, isConnectionError, isEnvBridgeError } from "./errors.ts"
import { connectionActions, decide, envActor, providerApis } from "./policy.ts"

import type { EnvAccessContext, EnvActivity } from "@vite-hub/env/bridge"
import type { ConnectionState, ConnectionStore } from "./store.ts"
import type {
  ConnectionApiCatalog,
  ConnectionApproval,
  ConnectionApprovalPage,
  ConnectionApprovalStatus,
  ConnectionDefinition,
  ConnectionInspection,
  ConnectionTokenResponse,
  ConnectionValue,
  UseConnectionOptions,
} from "./types.ts"

const REFRESH_WINDOW_MS = 60_000
const AUTHORIZATION_TTL_MS = 10 * 60_000

interface StoredToken {
  accessToken: string
  expiresAt?: number
  refreshToken?: string
  scopes: string[]
  tokenType: string
}

export interface ConnectionsRuntimeOptions {
  /** Connection definitions by name, or loaders that import them. */
  definitions: Readonly<Record<string, ConnectionDefinition | (() => Promise<unknown>)>>
  store: ConnectionStore | (() => ConnectionStore | Promise<ConnectionStore>)
  fetch?: typeof fetch
  now?: () => number
}

interface CallContext {
  actor: string
  approved?: boolean
  definition: ConnectionDefinition
  name: string
  options: UseConnectionOptions
}

interface ProviderRequest {
  action: string
  body?: string
  highRisk: boolean
  input?: unknown
  method: string
  url: string
  write: boolean
}

/** A stored approval input. Typed methods store their input; `fetch` stores the request. */
type ApprovalInput =
  | { input: unknown, kind: "method" }
  | { body?: string, contentType?: string, kind: "fetch", method: string, url: string }

/** An untyped client. `useConnection()` wraps it in the typed client tree. */
export interface ConnectionRuntimeClient {
  call: (action: string, input?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>
}

export interface ConnectionsRuntime {
  activity: (input: { before?: string, name: string }) => Promise<readonly EnvActivity[]>
  /** Return a bounded page. Pass `nextCursor` as `before` to continue. */
  approvals: (input?: { before?: string, name?: string, status?: ConnectionApprovalStatus }) => Promise<ConnectionApprovalPage>
  approvalCounts: () => Promise<Record<string, number>>
  /** Approve a pending write and run it under the actor that requested it. */
  approve: (input: { actor?: string, id: string }) => Promise<{ approval: ConnectionApproval, result?: unknown }>
  /** Start an authorization code flow with PKCE. Returns the provider URL. */
  authorize: (input: { actor?: string, name: string, redirectUri: string }) => Promise<{ state: string, url: string }>
  client: (name: string, options: UseConnectionOptions) => ConnectionRuntimeClient
  /** Exchange the authorization code and store the token. */
  complete: (input: { code: string, state: string }) => Promise<ConnectionInspection>
  definition: (name: string) => Promise<ConnectionDefinition>
  deny: (input: { actor?: string, id: string }) => Promise<ConnectionApproval>
  inspect: (name: string) => Promise<ConnectionInspection>
  list: () => Promise<ConnectionInspection[]>
  revoke: (input: { actor?: string, name: string }) => Promise<ConnectionInspection>
}

function isDefinition(value: unknown): value is ConnectionDefinition {
  return Boolean(value) && typeof value === "object" && "provider" in (value as object) && "scopes" in (value as object)
}

async function resolveValue(value: ConnectionValue | undefined): Promise<string | undefined> {
  return typeof value === "function" ? await value() : value
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)))
}

async function codeChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
}

function tokenKey(name: string): string {
  return `connection/${name}`
}

function splitScopes(scope: string | undefined): string[] | undefined {
  return scope?.split(/\s+/).filter(Boolean)
}

function parseToken(value: string, name: string): StoredToken {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  }
  catch {
    throw new ConnectionError("invalid", `Stored token for Connection "${name}" is invalid.`, { details: { connection: name } })
  }
  if (!parsed || typeof parsed !== "object" || !("accessToken" in parsed) || typeof parsed.accessToken !== "string") {
    throw new ConnectionError("reauth_required", `Connection "${name}" is not connected. Run \`vitehub connections connect ${name}\`.`, { details: { connection: name } })
  }
  return parsed as StoredToken
}

function buildMethodRequest(catalog: ConnectionApiCatalog, method: string, input: unknown): { body?: string, method: string, url: string } {
  const entry = catalog.methods[method]
  if (!entry) throw new ConnectionError("invalid", `Unknown method "${method}".`)
  const [httpMethod, template, acceptsBody] = entry
  const params: Record<string, unknown> = input && typeof input === "object" ? { ...(input as Record<string, unknown>) } : {}
  const body = params.requestBody
  delete params.requestBody
  const path = template.replace(/\{(\+?)([^}]+)\}/g, (_match, reserved: string, parameter: string) => {
    const value = params[parameter]
    if (value === undefined || value === null || value === "") throw new ConnectionError("invalid", `Method "${method}" requires "${parameter}".`)
    delete params[parameter]
    return reserved ? encodeURI(String(value)) : encodeURIComponent(String(value))
  })
  const url = new URL(path, catalog.rootUrl)
  for (const [parameter, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(parameter, String(item))
  }
  return {
    ...(acceptsBody && body !== undefined ? { body: JSON.stringify(body) } : {}),
    method: httpMethod,
    url: url.toString(),
  }
}

async function providerMessage(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.clone().json()
    const error = body && typeof body === "object" && "error" in body ? body.error : undefined
    const message = error && typeof error === "object" && "message" in error ? error.message : undefined
    return typeof message === "string" ? message.slice(0, 300) : undefined
  }
  catch {
    return undefined
  }
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  return text ? JSON.parse(text) : undefined
}

/** Create the Connections runtime. Applications normally use `useConnection()` instead. */
export function createConnectionsRuntime(options: ConnectionsRuntimeOptions): ConnectionsRuntime {
  const request = options.fetch ?? ((input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(input, init))
  const now = options.now ?? Date.now
  const refreshing = new Map<string, Promise<StoredToken>>()
  let store: Promise<ConnectionStore> | undefined
  const definitions = new Map<string, Promise<ConnectionDefinition | undefined>>()

  const getStore = () => (store ??= Promise.resolve(typeof options.store === "function" ? options.store() : options.store).catch((error: unknown) => {
    store = undefined
    throw error
  }))

  async function loadDefinition(name: string): Promise<ConnectionDefinition | undefined> {
    const entry = Object.hasOwn(options.definitions, name) ? options.definitions[name] : undefined
    if (!entry) return undefined
    if (isDefinition(entry)) return entry
    let loaded = definitions.get(name)
    if (!loaded) {
      loaded = entry().then((module) => {
        if (isDefinition(module)) return module
        const exported = module && typeof module === "object" && "default" in module ? module.default : undefined
        return isDefinition(exported) ? exported : undefined
      })
      definitions.set(name, loaded)
    }
    return await loaded
  }

  async function definition(name: string): Promise<ConnectionDefinition> {
    const loaded = await loadDefinition(name)
    if (!loaded) throw new ConnectionError("invalid", `No Connection Definition was discovered for "${name}".`, { details: { connection: name } })
    return loaded
  }

  function envContext(actor: string, options: UseConnectionOptions = {}): EnvAccessContext {
    // The Connection access map is the policy. Env Bridge stores the token and records activity.
    return {
      actor: envActor(actor),
      admin: true,
      ...(options.traceId ? { traceId: options.traceId } : {}),
      ...(options.invocationId ? { invocationId: options.invocationId } : {}),
    }
  }

  async function recordDenied(name: string, actor: string, action: string, options: UseConnectionOptions): Promise<void> {
    const event: EnvActivity = {
      action: "use",
      actor: envActor(actor),
      id: crypto.randomUUID(),
      key: tokenKey(name),
      operation: action,
      operationId: crypto.randomUUID(),
      outcome: "denied",
      timestamp: new Date(now()).toISOString(),
      ...(options.traceId ? { traceId: options.traceId } : {}),
      ...(options.invocationId ? { invocationId: options.invocationId } : {}),
    }
    await (await getStore()).access.append(event)
  }

  async function tokenRequest(definition: ConnectionDefinition, parameters: Record<string, string>): Promise<ConnectionTokenResponse> {
    const provider = definition.provider
    const clientId = await resolveValue(provider.clientId)
    const clientSecret = await resolveValue(provider.clientSecret)
    if (!clientId) throw new ConnectionError("invalid", `Provider "${provider.id}" has no client id.`)
    const response = await request(provider.tokenEndpoint, {
      body: new URLSearchParams({ ...parameters, client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) }),
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
    const body: unknown = await response.json().catch(() => undefined)
    const error = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : undefined
    if (!response.ok || error) {
      throw new ConnectionError(error === "invalid_grant" ? "reauth_required" : "provider", `Provider "${provider.id}" rejected the token request${error ? ` (${error})` : ""}.`, {
        details: { status: response.status },
      })
    }
    if (!body || typeof body !== "object" || !("access_token" in body) || typeof body.access_token !== "string") {
      throw new ConnectionError("provider", `Provider "${provider.id}" returned no access token.`)
    }
    return body as ConnectionTokenResponse
  }

  function toStoredToken(response: ConnectionTokenResponse, previous?: StoredToken): StoredToken {
    return {
      accessToken: response.access_token,
      ...(response.expires_in ? { expiresAt: now() + response.expires_in * 1000 } : {}),
      ...(response.refresh_token ?? previous?.refreshToken ? { refreshToken: response.refresh_token ?? previous?.refreshToken } : {}),
      scopes: splitScopes(response.scope) ?? previous?.scopes ?? [],
      tokenType: response.token_type ?? "Bearer",
    }
  }

  function expiresSoon(token: StoredToken): boolean {
    return token.expiresAt !== undefined && token.expiresAt - now() < REFRESH_WINDOW_MS
  }

  async function setStatus(name: string, patch: Partial<ConnectionState>): Promise<void> {
    const connections = await getStore()
    const current = await connections.state.get(name)
    await connections.state.put({
      name,
      scopes: [],
      status: "connected",
      ...current,
      ...patch,
      updatedAt: new Date(now()).toISOString(),
    })
  }

  /**
   * Refresh the stored token. `stale` is the access token the caller used. When the
   * stored token already differs, another request refreshed it first.
   */
  async function refreshToken(name: string, definition: ConnectionDefinition, stale: string, force: boolean): Promise<StoredToken> {
    const connections = await getStore()
    const key = tokenKey(name)
    const stored = await connections.secrets.read(key)
    if (!stored) throw new ConnectionError("reauth_required", `Connection "${name}" is not connected.`, { details: { connection: name } })
    const latest = parseToken(stored.value, name)
    if (latest.accessToken !== stale && !expiresSoon(latest)) return latest
    if (!force && !expiresSoon(latest)) return latest
    if (!latest.refreshToken) {
      await setStatus(name, { status: "reauth_required" })
      throw new ConnectionError("reauth_required", `Connection "${name}" has no refresh token. Connect it again.`, { details: { connection: name } })
    }
    let response: ConnectionTokenResponse
    try {
      response = await tokenRequest(definition, { grant_type: "refresh_token", refresh_token: latest.refreshToken })
    }
    catch (error) {
      if (isConnectionError(error) && error.reason === "reauth_required") {
        await setStatus(name, { status: "reauth_required" })
        throw new ConnectionError("reauth_required", `Connection "${name}" must be connected again. Run \`vitehub connections connect ${name}\`.`, { details: { connection: name } })
      }
      throw error
    }
    const next = toStoredToken(response, latest)
    try {
      await connections.bridge.replace(envContext("connections"), { expectedRevision: stored.revision ?? null, key, value: JSON.stringify(next) })
    }
    catch (error) {
      if (!isEnvBridgeError(error, "ENV_BRIDGE_CONFLICT")) throw error
      // Another isolate wrote a newer token. Use it.
      const current = await connections.secrets.read(key)
      if (!current) throw new ConnectionError("reauth_required", `Connection "${name}" is not connected.`, { details: { connection: name } })
      return parseToken(current.value, name)
    }
    await setStatus(name, { refreshedAt: new Date(now()).toISOString() })
    return next
  }

  function refresh(name: string, definition: ConnectionDefinition, stale: string, force: boolean): Promise<StoredToken> {
    const key = `${name}\0${stale}`
    let pending = refreshing.get(key)
    if (!pending) {
      pending = refreshToken(name, definition, stale, force).finally(() => refreshing.delete(key))
      refreshing.set(key, pending)
    }
    return pending
  }

  async function requireConnected(name: string): Promise<void> {
    const state = await (await getStore()).state.get(name)
    if (state?.status === "connected") return
    const message = state?.status === "reauth_required"
      ? `Connection "${name}" must be connected again. Run \`vitehub connections connect ${name}\`.`
      : `Connection "${name}" is not connected. Run \`vitehub connections connect ${name}\`.`
    throw new ConnectionError("reauth_required", message, { details: { connection: name } })
  }

  /** Send one provider request with the Connection token inside an audited Env Bridge use. */
  async function send(context: CallContext, providerRequest: ProviderRequest, init: { contentType?: string, signal?: AbortSignal } = {}): Promise<Response> {
    const connections = await getStore()
    await requireConnected(context.name)
    let failure: unknown
    try {
      return await connections.bridge.use(envContext(context.actor, context.options), tokenKey(context.name), providerRequest.action, async (secret) => {
        try {
          let token = parseToken(secret.unseal(), context.name)
          if (expiresSoon(token)) token = await refresh(context.name, context.definition, token.accessToken, false)
          const call = (current: StoredToken) => request(providerRequest.url, {
            ...(providerRequest.body === undefined ? {} : { body: providerRequest.body }),
            headers: {
              accept: "application/json",
              authorization: `${current.tokenType === "bearer" ? "Bearer" : current.tokenType} ${current.accessToken}`,
              ...(providerRequest.body === undefined ? {} : { "content-type": init.contentType ?? "application/json" }),
            },
            method: providerRequest.method,
            ...(init.signal ? { signal: init.signal } : {}),
          })
          let response = await call(token)
          if (response.status === 401) {
            token = await refresh(context.name, context.definition, token.accessToken, true)
            response = await call(token)
          }
          if (!response.ok && providerRequest.action !== "fetch") {
            const message = await providerMessage(response)
            throw new ConnectionError("provider", `Provider rejected ${providerRequest.action} with ${response.status}${message ? `: ${message}` : "."}`, {
              details: { action: providerRequest.action, connection: context.name, status: response.status },
            })
          }
          return response
        }
        catch (error) {
          failure = error
          throw error
        }
      })
    }
    catch (error) {
      if (failure) throw failure
      if (isEnvBridgeError(error, "ENV_BRIDGE_MISSING")) {
        throw new ConnectionError("reauth_required", `Connection "${context.name}" is not connected.`, { details: { connection: context.name } })
      }
      throw error
    }
  }

  /** Apply policy, dry run, and approval, then send. Returns `undefined` when dry run skips a write. */
  async function governed(context: CallContext, providerRequest: ProviderRequest, approvalInput: ApprovalInput, init: { contentType?: string, signal?: AbortSignal } = {}): Promise<Response | undefined> {
    const decision = decide({
      action: providerRequest.action,
      actor: context.actor,
      approved: context.approved,
      definition: context.definition,
      highRisk: providerRequest.highRisk,
      write: providerRequest.write,
    })
    if (decision === "deny") {
      await recordDenied(context.name, context.actor, providerRequest.action, context.options)
      throw new ConnectionError("denied", `Actor "${context.actor}" may not call ${providerRequest.action} on Connection "${context.name}".`, {
        details: { action: providerRequest.action, connection: context.name },
      })
    }
    if (providerRequest.write && context.options.dryRun) {
      context.options.onEffect?.({
        kind: providerRequest.action,
        payload: {
          connection: context.name,
          ...(providerRequest.input === undefined ? {} : { input: providerRequest.input }),
          method: providerRequest.method,
          url: providerRequest.url,
        },
        read: false,
        skipped: "dry-run",
      })
      return undefined
    }
    if (decision === "approve") {
      const approval: ConnectionApproval = {
        action: providerRequest.action,
        actor: context.actor,
        createdAt: new Date(now()).toISOString(),
        id: `approval_${randomToken().slice(0, 20)}`,
        input: approvalInput,
        name: context.name,
        status: "pending",
        ...(context.options.traceId ? { traceId: context.options.traceId } : {}),
        ...(context.options.invocationId ? { invocationId: context.options.invocationId } : {}),
      }
      await (await getStore()).approvals.create(approval)
      throw new ConnectionError("approval_required", `Approval is required for ${providerRequest.action} on Connection "${context.name}". Request: ${approval.id}.`, {
        details: { action: providerRequest.action, connection: context.name },
        requestId: approval.id,
      })
    }
    return await send(context, providerRequest, init)
  }

  function findCatalog(definition: ConnectionDefinition, action: string): { api: string, catalog: ConnectionApiCatalog, method: string } | undefined {
    const apis = providerApis(definition)
    const api = action.slice(0, action.indexOf("."))
    const catalog = Object.hasOwn(apis, api) ? apis[api] : undefined
    return catalog ? { api, catalog, method: action.slice(api.length + 1) } : undefined
  }

  async function callMethod(context: CallContext, action: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const found = findCatalog(context.definition, action)
    const info = connectionActions(context.definition).find(candidate => candidate.id === action)
    if (!found || !info) throw new ConnectionError("invalid", `Connection "${context.name}" does not expose ${action}.`, { details: { action, connection: context.name } })
    const built = buildMethodRequest(found.catalog, found.method, input)
    const response = await governed(context, { ...built, action, highRisk: info.highRisk, input, write: info.write }, { input, kind: "method" }, { signal })
    return response ? await readResponse(response) : undefined
  }

  async function callFetch(context: CallContext, input: string | URL, init: RequestInit = {}): Promise<Response | undefined> {
    const url = new URL(input)
    const method = (init.method ?? "GET").toUpperCase()
    const write = method !== "GET" && method !== "HEAD"
    const allowed = Object.values(providerApis(context.definition)).some(catalog => url.origin === new URL(catalog.rootUrl).origin)
    if (!allowed) throw new ConnectionError("invalid", `Connection "${context.name}" does not send its token to ${url.origin}.`, { details: { connection: context.name } })
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
      throw new ConnectionError("invalid", "Connection fetch accepts only a string body.")
    }
    const body = init.body ?? undefined
    const contentType = new Headers(init.headers).get("content-type") ?? undefined
    return await governed(
      context,
      { action: "fetch", ...(body === undefined ? {} : { body }), highRisk: false, input: { method, url: url.toString() }, method, url: url.toString(), write },
      { ...(body === undefined ? {} : { body }), ...(contentType ? { contentType } : {}), kind: "fetch", method, url: url.toString() },
      { ...(contentType ? { contentType } : {}), ...(init.signal ? { signal: init.signal } : {}) },
    )
  }

  function buildClient(name: string, options: UseConnectionOptions): ConnectionRuntimeClient {
    const actor = options.actor ?? "server"
    let context: Promise<CallContext> | undefined
    const resolveContext = () => (context ??= definition(name).then(loaded => ({ actor, definition: loaded, name, options })))
    return {
      async call(action: string, input?: unknown, callOptions?: { signal?: AbortSignal }): Promise<unknown> {
        return await callMethod(await resolveContext(), action, input, callOptions?.signal)
      },
      async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
        return await callFetch(await resolveContext(), input, init) ?? new Response(null, { status: 204 })
      },
    }
  }

  async function inspect(name: string): Promise<ConnectionInspection> {
    const loaded = await definition(name)
    const state = await (await getStore()).state.get(name)
    const declared = [...loaded.scopes]
    const granted = state?.scopes ?? []
    return {
      ...(state?.accountId ? { account: { id: state.accountId, ...(state.accountEmail ? { email: state.accountEmail } : {}) } } : {}),
      actions: connectionActions(loaded),
      ...(state?.connectedAt ? { connectedAt: state.connectedAt } : {}),
      name,
      provider: loaded.provider.id,
      ...(state?.refreshedAt ? { refreshedAt: state.refreshedAt } : {}),
      scopes: {
        declared,
        granted,
        missing: state?.status === "connected" ? declared.filter(scope => !granted.includes(scope)) : declared,
      },
      status: state?.status ?? "disconnected",
    }
  }

  async function authorize(input: { actor?: string, name: string, redirectUri: string }): Promise<{ state: string, url: string }> {
    const loaded = await definition(input.name)
    const provider = loaded.provider
    const clientId = await resolveValue(provider.clientId)
    if (!clientId) throw new ConnectionError("invalid", `Provider "${provider.id}" has no client id.`)
    const redirect = new URL(input.redirectUri)
    if (redirect.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname)) {
      throw new ConnectionError("invalid", "The redirect URI must use HTTPS or a loopback address.")
    }
    const state = randomToken()
    const verifier = randomToken()
    await (await getStore()).authorizations.put({
      actor: input.actor ?? "user:local",
      expiresAt: now() + AUTHORIZATION_TTL_MS,
      name: input.name,
      redirectUri: redirect.toString(),
      state,
      verifier,
    })
    const url = new URL(provider.authorizationEndpoint)
    const scopes = [...new Set([...(provider.identityScopes ?? []), ...loaded.scopes])]
    for (const [parameter, value] of Object.entries({
      client_id: clientId,
      code_challenge: await codeChallenge(verifier),
      code_challenge_method: "S256",
      redirect_uri: redirect.toString(),
      response_type: "code",
      scope: scopes.join(" "),
      state,
      ...provider.authorizationParams,
    })) url.searchParams.set(parameter, value)
    return { state, url: url.toString() }
  }

  async function complete(input: { code: string, state: string }): Promise<ConnectionInspection> {
    const connections = await getStore()
    const authorization = await connections.authorizations.take(input.state)
    if (!authorization || authorization.expiresAt < now()) throw new ConnectionError("invalid", "The authorization request is unknown or expired. Start the connection again.")
    const name = authorization.name
    const loaded = await definition(name)
    const response = await tokenRequest(loaded, {
      code: input.code,
      code_verifier: authorization.verifier,
      grant_type: "authorization_code",
      redirect_uri: authorization.redirectUri,
    })
    const account = loaded.provider.account(response)
    const state = await connections.state.get(name)
    if (state?.status !== "revoked" && state?.accountId && account && state.accountId !== account.id) {
      await revokeProviderToken(loaded, response.refresh_token ?? response.access_token)
      throw new ConnectionError("invalid", `Connection "${name}" belongs to another account. Revoke it before you connect a different account.`, { details: { connection: name } })
    }
    const token = toStoredToken(response)
    const key = tokenKey(name)
    const current = await connections.secrets.inspect(key)
    await connections.bridge.replace(envContext(authorization.actor), { expectedRevision: current?.revision ?? null, key, value: JSON.stringify(token) })
    const timestamp = new Date(now()).toISOString()
    await connections.state.put({
      ...(account?.email ? { accountEmail: account.email } : {}),
      ...(account ? { accountId: account.id } : {}),
      connectedAt: timestamp,
      name,
      refreshedAt: timestamp,
      scopes: token.scopes,
      status: "connected",
      updatedAt: timestamp,
    })
    return await inspect(name)
  }

  async function revokeProviderToken(definition: ConnectionDefinition, token: string): Promise<void> {
    if (!definition.provider.revocationEndpoint) return
    try {
      await request(definition.provider.revocationEndpoint, {
        body: new URLSearchParams({ token }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      })
    }
    catch {}
  }

  async function revoke(input: { actor?: string, name: string }): Promise<ConnectionInspection> {
    const loaded = await definition(input.name)
    const connections = await getStore()
    const key = tokenKey(input.name)
    const actor = input.actor ?? "user:local"
    const stored = await connections.secrets.inspect(key)
    if (stored) {
      await connections.bridge.use(envContext(actor), key, "revoke", async (secret) => {
        let token: StoredToken | undefined
        try {
          token = parseToken(secret.unseal(), input.name)
        }
        catch {}
        if (token) await revokeProviderToken(loaded, token.refreshToken ?? token.accessToken)
      })
      // Env Bridge has no delete. A revoked marker replaces the token.
      await connections.bridge.replace(envContext(actor), { expectedRevision: stored.revision, key, value: JSON.stringify({ revoked: true }) })
    }
    await setStatus(input.name, { status: "revoked" })
    return await inspect(input.name)
  }

  async function list(): Promise<ConnectionInspection[]> {
    return await Promise.all(Object.keys(options.definitions).sort().map(name => inspect(name)))
  }

  async function activity(input: { before?: string, name: string }): Promise<readonly EnvActivity[]> {
    await definition(input.name)
    return await (await getStore()).bridge.activity(envContext("connections"), tokenKey(input.name), input.before)
  }

  async function approvals(input: { before?: string, name?: string, status?: ConnectionApprovalStatus } = {}): Promise<ConnectionApprovalPage> {
    return await (await getStore()).approvals.list(input)
  }

  async function approvalCounts(): Promise<Record<string, number>> {
    return await (await getStore()).approvals.pendingCounts(Object.keys(options.definitions))
  }

  async function approve(input: { actor?: string, id: string }): Promise<{ approval: ConnectionApproval, result?: unknown }> {
    const connections = await getStore()
    const decidedAt = new Date(now()).toISOString()
    const approval = await connections.approvals.transition(input.id, "pending", "approved", { decidedAt, decidedBy: input.actor ?? "user:local" })
    if (!approval) throw new ConnectionError("invalid", `Approval "${input.id}" is not pending.`)
    const stored = approval.input as ApprovalInput
    try {
      const loaded = await definition(approval.name)
      const context: CallContext = {
        actor: approval.actor,
        approved: true,
        definition: loaded,
        name: approval.name,
        options: {
          ...(approval.traceId ? { traceId: approval.traceId } : {}),
          ...(approval.invocationId ? { invocationId: approval.invocationId } : {}),
        },
      }
      let result: unknown
      if (stored.kind === "fetch") {
        const response = await callFetch(context, stored.url, {
          ...(stored.body === undefined ? {} : { body: stored.body }),
          ...(stored.contentType ? { headers: { "content-type": stored.contentType } } : {}),
          method: stored.method,
        })
        result = response ? { status: response.status } : undefined
      }
      else {
        result = await callMethod(context, approval.action, stored.input)
      }
      const executed = await connections.approvals.transition(input.id, "approved", "executed")
      return { approval: executed ?? approval, ...(result === undefined ? {} : { result }) }
    }
    catch (error) {
      const code = isConnectionError(error) ? error.code : "CONNECTION_FAILED"
      await connections.approvals.transition(input.id, "approved", "failed", { error: code })
      throw error
    }
  }

  async function deny(input: { actor?: string, id: string }): Promise<ConnectionApproval> {
    const approval = await (await getStore()).approvals.transition(input.id, "pending", "denied", {
      decidedAt: new Date(now()).toISOString(),
      decidedBy: input.actor ?? "user:local",
    })
    if (!approval) throw new ConnectionError("invalid", `Approval "${input.id}" is not pending.`)
    return approval
  }

  return {
    activity,
    approvals,
    approvalCounts,
    approve,
    authorize,
    client: buildClient,
    complete,
    definition,
    deny,
    inspect,
    list,
    revoke,
  }
}
