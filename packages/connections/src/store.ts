import { createEnvBridge } from "@vite-hub/env/bridge"
import { createDatabaseEnvStore } from "@vite-hub/env/database"
import { sql } from "drizzle-orm"
import * as v from "valibot"

import { ConnectionError } from "./errors.ts"

import type { EnvAccessStore, EnvBridge, EnvSecretStore } from "@vite-hub/env/bridge"
import type { EnvDatabase } from "@vite-hub/env/database"
import type { ConnectionApproval, ConnectionApprovalStatus } from "./types.ts"

export interface ConnectionState {
  accountEmail?: string
  accountId?: string
  connectedAt?: string
  name: string
  refreshedAt?: string
  scopes: string[]
  status: "connected" | "reauth_required" | "revoked"
  updatedAt: string
}

export interface ConnectionAuthorization {
  actor: string
  expiresAt: number
  name: string
  redirectUri: string
  state: string
  verifier: string
}

/** Storage for Connections. Tokens live in the Env Bridge secret store. */
export interface ConnectionStore {
  approvals: {
    /** Mark expired approval executions as failed with an unknown provider outcome. Never replay them. */
    recover: (before: string) => Promise<void>
    create: (approval: ConnectionApproval) => Promise<void>
    get: (id: string) => Promise<ConnectionApproval | undefined>
    list: (input: { name?: string, status?: ConnectionApprovalStatus }) => Promise<ConnectionApproval[]>
    /** Move an approval from one status to another. Returns `undefined` when the status was not `from`. */
    transition: (id: string, from: ConnectionApprovalStatus, to: ConnectionApprovalStatus, patch?: { decidedAt?: string, decidedBy?: string, error?: string }) => Promise<ConnectionApproval | undefined>
  }
  authorizations: {
    put: (authorization: ConnectionAuthorization) => Promise<void>
    /** Read and delete one pending authorization. */
    take: (state: string) => Promise<ConnectionAuthorization | undefined>
  }
  bridge: EnvBridge
  secrets: EnvSecretStore
  access: EnvAccessStore
  state: {
    get: (name: string) => Promise<ConnectionState | undefined>
    put: (state: ConnectionState) => Promise<void>
  }
}

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(512))
const stateRow = v.object({
  account_email: v.nullable(v.string()),
  account_id: v.nullable(v.string()),
  connected_at: v.nullable(v.string()),
  name: identifier,
  refreshed_at: v.nullable(v.string()),
  scopes: v.string(),
  status: v.picklist(["connected", "reauth_required", "revoked"]),
  updated_at: v.string(),
})
const authorizationRow = v.object({
  actor: identifier,
  expires_at: v.number(),
  name: identifier,
  redirect_uri: v.string(),
  state: identifier,
  verifier: identifier,
})
const approvalRow = v.object({
  action: identifier,
  actor: identifier,
  created_at: v.string(),
  decided_at: v.nullable(v.string()),
  decided_by: v.nullable(v.string()),
  error: v.nullable(v.string()),
  id: identifier,
  input: v.string(),
  invocation_id: v.nullable(v.string()),
  name: identifier,
  status: v.picklist(["approved", "denied", "executed", "failed", "pending"]),
  trace_id: v.nullable(v.string()),
})

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  }
  catch {
    throw new ConnectionError("invalid", "Stored Connection data is invalid.")
  }
}

function stringArray(value: string): string[] {
  const parsed = parseJson(value)
  const result = v.safeParse(v.array(v.string()), parsed)
  if (!result.success) throw new ConnectionError("invalid", "Stored Connection scopes are invalid.")
  return result.output
}

function toApproval(row: unknown): ConnectionApproval {
  const stored = v.parse(approvalRow, row)
  const approval: ConnectionApproval = {
    action: stored.action,
    actor: stored.actor,
    createdAt: stored.created_at,
    id: stored.id,
    input: parseJson(stored.input),
    name: stored.name,
    status: stored.status,
  }
  if (stored.decided_at) approval.decidedAt = stored.decided_at
  if (stored.decided_by) approval.decidedBy = stored.decided_by
  if (stored.error) approval.error = stored.error
  if (stored.invocation_id) approval.invocationId = stored.invocation_id
  if (stored.trace_id) approval.traceId = stored.trace_id
  return approval
}

/**
 * Store Connections in a ViteHub SQLite database. Tokens are encrypted with
 * AES-GCM through the Env Bridge store in the `connections` namespace.
 */
export function createDatabaseConnectionStore(options: { db: EnvDatabase, encryptionKey: Uint8Array }): ConnectionStore {
  const envStore = createDatabaseEnvStore({ db: options.db, encryptionKey: options.encryptionKey, namespace: "connections" })
  const bridge = createEnvBridge({
    ...envStore,
    runtimeContext: () => ({ actor: { id: "connections", kind: "service" }, admin: true }),
  })
  const db = options.db
  let ready: Promise<void> | undefined
  const initialize = () => (ready ??= (async () => {
    await db.run(sql`CREATE TABLE IF NOT EXISTS vitehub_connection_state (name TEXT PRIMARY KEY, status TEXT NOT NULL, account_id TEXT, account_email TEXT, scopes TEXT NOT NULL, connected_at TEXT, refreshed_at TEXT, updated_at TEXT NOT NULL)`)
    await db.run(sql`CREATE TABLE IF NOT EXISTS vitehub_connection_authorizations (state TEXT PRIMARY KEY, name TEXT NOT NULL, actor TEXT NOT NULL, verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL, expires_at INTEGER NOT NULL)`)
    await db.run(sql`CREATE TABLE IF NOT EXISTS vitehub_connection_approvals (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, trace_id TEXT, invocation_id TEXT, created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, error TEXT)`)
    await db.run(sql`CREATE INDEX IF NOT EXISTS vitehub_connection_approvals_status ON vitehub_connection_approvals (status, sequence)`)
  })().catch((error: unknown) => {
    ready = undefined
    throw error
  }))
  const approvalColumns = sql`id, name, actor, action, input, status, trace_id, invocation_id, created_at, decided_at, decided_by, error`

  return {
    ...envStore,
    bridge,
    state: {
      async get(name) {
        await initialize()
        const row = (await db.all(sql`SELECT name, status, account_id, account_email, scopes, connected_at, refreshed_at, updated_at FROM vitehub_connection_state WHERE name = ${name}`))[0]
        if (row === undefined) return undefined
        const stored = v.parse(stateRow, row)
        const state: ConnectionState = {
          name: stored.name,
          scopes: stringArray(stored.scopes),
          status: stored.status,
          updatedAt: stored.updated_at,
        }
        if (stored.account_email) state.accountEmail = stored.account_email
        if (stored.account_id) state.accountId = stored.account_id
        if (stored.connected_at) state.connectedAt = stored.connected_at
        if (stored.refreshed_at) state.refreshedAt = stored.refreshed_at
        return state
      },
      async put(state) {
        await initialize()
        await db.run(sql`INSERT INTO vitehub_connection_state (name, status, account_id, account_email, scopes, connected_at, refreshed_at, updated_at) VALUES (${state.name}, ${state.status}, ${state.accountId ?? null}, ${state.accountEmail ?? null}, ${JSON.stringify(state.scopes)}, ${state.connectedAt ?? null}, ${state.refreshedAt ?? null}, ${state.updatedAt}) ON CONFLICT (name) DO UPDATE SET status = excluded.status, account_id = excluded.account_id, account_email = excluded.account_email, scopes = excluded.scopes, connected_at = excluded.connected_at, refreshed_at = excluded.refreshed_at, updated_at = excluded.updated_at`)
      },
    },
    authorizations: {
      async put(authorization) {
        await initialize()
        await db.run(sql`DELETE FROM vitehub_connection_authorizations WHERE expires_at < ${Date.now()}`)
        await db.run(sql`INSERT INTO vitehub_connection_authorizations (state, name, actor, verifier, redirect_uri, expires_at) VALUES (${authorization.state}, ${authorization.name}, ${authorization.actor}, ${authorization.verifier}, ${authorization.redirectUri}, ${authorization.expiresAt})`)
      },
      async take(state) {
        await initialize()
        const row = (await db.all(sql`DELETE FROM vitehub_connection_authorizations WHERE state = ${state} RETURNING state, name, actor, verifier, redirect_uri, expires_at`))[0]
        if (row === undefined) return undefined
        const stored = v.parse(authorizationRow, row)
        return { actor: stored.actor, expiresAt: stored.expires_at, name: stored.name, redirectUri: stored.redirect_uri, state: stored.state, verifier: stored.verifier }
      },
    },
    approvals: {
      async recover(before) {
        await initialize()
        await db.run(sql`UPDATE vitehub_connection_approvals SET status = 'failed', error = 'CONNECTION_EXECUTION_UNKNOWN' WHERE status = 'approved' AND (decided_at IS NULL OR decided_at <= ${before})`)
      },
      async create(approval) {
        await initialize()
        await db.run(sql`INSERT INTO vitehub_connection_approvals (id, name, actor, action, input, status, trace_id, invocation_id, created_at) VALUES (${approval.id}, ${approval.name}, ${approval.actor}, ${approval.action}, ${JSON.stringify(approval.input ?? null)}, ${approval.status}, ${approval.traceId ?? null}, ${approval.invocationId ?? null}, ${approval.createdAt})`)
      },
      async get(id) {
        await initialize()
        const row = (await db.all(sql`SELECT ${approvalColumns} FROM vitehub_connection_approvals WHERE id = ${id}`))[0]
        return row === undefined ? undefined : toApproval(row)
      },
      async list({ name, status }) {
        await initialize()
        const rows = await db.all(sql`SELECT ${approvalColumns} FROM vitehub_connection_approvals WHERE 1 = 1 ${name ? sql`AND name = ${name}` : sql``} ${status ? sql`AND status = ${status}` : sql``} ORDER BY sequence DESC LIMIT 100`)
        return rows.map(toApproval)
      },
      async transition(id, from, to, patch = {}) {
        await initialize()
        const row = (await db.all(sql`UPDATE vitehub_connection_approvals SET status = ${to}, decided_at = COALESCE(${patch.decidedAt ?? null}, decided_at), decided_by = COALESCE(${patch.decidedBy ?? null}, decided_by), error = COALESCE(${patch.error ?? null}, error) WHERE id = ${id} AND status = ${from} RETURNING ${approvalColumns}`))[0]
        return row === undefined ? undefined : toApproval(row)
      },
    },
  }
}
