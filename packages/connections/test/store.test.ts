import { sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"

import { createConnectionsStore } from "../src/store.ts"
import { accessToken, createDatabase, expectCode, refreshToken, rows, testKey, tokenSet } from "./helpers.ts"

import type { ConnectionActivity, ConnectionActor } from "../src/types.ts"

const actor: ConnectionActor = { id: "owner", kind: "user" }

function setup(fill = 7) {
  const db = createDatabase()
  return { db, store: createConnectionsStore({ db, encryptionKey: testKey(fill) }) }
}

function pending(overrides: { expiresAt?: number, name?: string, state?: string, ticket?: string } = {}) {
  return {
    actor,
    expiresAt: Date.now() + 60_000,
    name: "gmail",
    redirectUri: "https://app.example/_vitehub/connections/gmail/callback",
    state: "state-1",
    ticket: "ticket-1",
    verifier: "verifier-1",
    ...overrides,
  }
}

function activity(id: string, connection = "gmail"): ConnectionActivity {
  return { action: "call", actor, connection, id, outcome: "succeeded", timestamp: new Date().toISOString() }
}

describe("createConnectionsStore", () => {
  it("round trips a sealed token set", async () => {
    const { store } = setup()
    const tokens = tokenSet()
    const grant = await store.write({ name: "gmail", provider: "google", tokens })

    expect(grant).toMatchObject({
      account: "owner@example.com",
      expiresAt: tokens.expiresAt,
      keyMatches: true,
      provider: "google",
      revision: expect.any(String),
      scopes: ["test.read", "test.write"],
      status: "active",
    })
    expect(grant.leaseUntil).toBeUndefined()
    expect(await store.tokens("gmail")).toEqual({ grant, tokens })
    expect(await store.grant("gmail")).toEqual(grant)
    expect(await store.tokens("missing")).toBeUndefined()
    expect(await store.grant("missing")).toBeUndefined()
  })

  it("does not store tokens in plain text", async () => {
    const { db, store } = setup()
    await store.write({ name: "gmail", provider: "google", tokens: tokenSet() })

    const stored = JSON.stringify(await rows(db, "vitehub_connection_grants"))
    expect(stored).not.toContain(accessToken)
    expect(stored).not.toContain(refreshToken)
    expect(stored).toContain("owner@example.com")
  })

  it("binds the sealed payload to the Connection name and revision", async () => {
    const { db, store } = setup()
    await store.write({ name: "gmail", provider: "google", tokens: tokenSet() })
    await store.write({ name: "drive", provider: "google", tokens: tokenSet({ accessToken: "other" }) })

    await db.run(sql`UPDATE vitehub_connection_grants SET payload = (SELECT payload FROM vitehub_connection_grants WHERE name = 'drive') WHERE name = 'gmail'`)
    await expect(store.tokens("gmail")).rejects.toThrow()
  })

  it("replaces a grant on reconnect with a new revision", async () => {
    const { store } = setup()
    const first = await store.write({ name: "gmail", provider: "google", tokens: tokenSet() })
    const second = await store.write({ name: "gmail", provider: "google", tokens: tokenSet({ accessToken: "second", account: undefined }) })

    expect(second.revision).not.toBe(first.revision)
    expect(second.account).toBeUndefined()
    expect((await store.tokens("gmail"))?.tokens.accessToken).toBe("second")
  })

  it("gives the refresh lease to one caller at a time", async () => {
    const { store } = setup()
    const grant = await store.write({ name: "gmail", provider: "google", tokens: tokenSet() })
    const now = 1_000_000

    expect(await store.lease("gmail", grant.revision, now, now + 30_000)).toBe(true)
    expect((await store.grant("gmail"))?.leaseUntil).toBe(now + 30_000)
    expect(await store.lease("gmail", grant.revision, now + 1_000, now + 31_000)).toBe(false)
    expect(await store.lease("gmail", grant.revision, now + 30_001, now + 60_001)).toBe(true)
    expect(await store.lease("gmail", "stale-revision", now + 90_000, now + 120_000)).toBe(false)
    expect(await store.lease("missing", grant.revision, now, now + 1)).toBe(false)
  })

  it("replaces only the expected revision and clears the lease", async () => {
    const { store } = setup()
    const grant = await store.write({ name: "gmail", provider: "google", tokens: tokenSet() })
    await store.lease("gmail", grant.revision, Date.now(), Date.now() + 30_000)

    const next = await store.write({ expectedRevision: grant.revision, name: "gmail", provider: "google", tokens: tokenSet({ accessToken: "next" }) })
    expect(next.leaseUntil).toBeUndefined()
    expect(next.revision).not.toBe(grant.revision)
    await expectCode(store.write({ expectedRevision: grant.revision, name: "gmail", provider: "google", tokens: tokenSet() }), "CONNECTIONS_UNAVAILABLE")
    expect((await store.tokens("gmail"))?.tokens.accessToken).toBe("next")
  })

  it("releases the lease with a status and error", async () => {
    const { store } = setup()
    const grant = await store.write({ name: "gmail", provider: "google", tokens: tokenSet() })
    await store.lease("gmail", grant.revision, Date.now(), Date.now() + 30_000)

    await store.release("gmail", "needs-reconnect", "CONNECTIONS_NEEDS_RECONNECT")
    expect(await store.grant("gmail")).toMatchObject({ lastError: "CONNECTIONS_NEEDS_RECONNECT", status: "needs-reconnect" })
    expect((await store.grant("gmail"))?.leaseUntil).toBeUndefined()
  })

  it("reports a key mismatch for grants sealed with another key", async () => {
    const db = createDatabase()
    await createConnectionsStore({ db, encryptionKey: testKey(1) }).write({ name: "gmail", provider: "google", tokens: tokenSet() })
    const other = createConnectionsStore({ db, encryptionKey: testKey(2) })

    expect(await other.grant("gmail")).toMatchObject({ keyMatches: false })
    await expectCode(other.tokens("gmail"), "CONNECTIONS_KEY_MISMATCH")
  })

  it("deletes grants", async () => {
    const { store } = setup()
    await store.write({ name: "gmail", provider: "google", tokens: tokenSet() })
    await store.deleteGrant("gmail")
    expect(await store.grant("gmail")).toBeUndefined()
  })

  it("opens a pending ticket once and consumes its state once", async () => {
    const { db, store } = setup()
    await store.createPending(pending())
    expect(JSON.stringify(await rows(db, "vitehub_connection_pending"))).not.toContain("verifier-1")

    expect(await store.consumePending("state-1", Date.now())).toBeUndefined()
    const opened = await store.openPending("ticket-1", Date.now())
    expect(opened).toEqual({
      actor,
      name: "gmail",
      redirectUri: "https://app.example/_vitehub/connections/gmail/callback",
      state: "state-1",
      verifier: "verifier-1",
    })
    expect(await store.openPending("ticket-1", Date.now())).toBeUndefined()
    expect(await store.consumePending("state-1", Date.now())).toEqual(opened)
    expect(await store.consumePending("state-1", Date.now())).toBeUndefined()
  })

  it("rejects expired pending connects", async () => {
    const { store } = setup()
    const expiresAt = Date.now() + 60_000
    await store.createPending(pending({ expiresAt }))

    expect(await store.openPending("ticket-1", expiresAt + 1)).toBeUndefined()
    expect(await store.openPending("ticket-1", expiresAt)).toBeDefined()
    expect(await store.consumePending("state-1", expiresAt + 1)).toBeUndefined()
  })

  it("lists activity newest first with a cursor and a Connection filter", async () => {
    const { store } = setup()
    for (const id of ["a", "b", "c"]) await store.append(activity(id))
    await store.append(activity("d", "drive"))

    expect((await store.activity({})).map(event => event.id)).toEqual(["d", "c", "b", "a"])
    expect((await store.activity({ connection: "gmail", limit: 2 })).map(event => event.id)).toEqual(["c", "b"])
    expect((await store.activity({ before: "b", connection: "gmail" })).map(event => event.id)).toEqual(["a"])
    expect((await store.activity({ limit: 0 })).map(event => event.id)).toEqual(["d"])
  })
})
