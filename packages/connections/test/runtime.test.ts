import { describe, expect, it } from "vitest"

import { isConnectionError } from "../src/errors.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { ACCESS_TOKEN, CLIENT_SECRET, connect, createStore, createTestRuntime, mailConnection, REFRESH_TOKEN } from "./helpers.ts"

import type { ConnectionEffect } from "../src/types.ts"

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  }
  catch (error) {
    return error
  }
  throw new Error("Expected the promise to reject.")
}

function base64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

describe("connect", () => {
  it("builds a PKCE authorization URL and stores the exchanged token", async () => {
    const test = createTestRuntime()
    const { state, url } = await test.runtime.authorize({ name: "mail", redirectUri: "http://127.0.0.1:8976/callback" })
    const authorization = new URL(url)
    expect(authorization.origin + authorization.pathname).toBe("https://auth.example.com/authorize")
    expect(authorization.searchParams.get("scope")).toBe("openid mail.modify")
    expect(authorization.searchParams.get("access_type")).toBe("offline")
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authorization.searchParams.get("state")).toBe(state)

    test.provider.tokenResponses.push({ body: { access_token: ACCESS_TOKEN, expires_in: 3600, id_token: "account-1", refresh_token: REFRESH_TOKEN, scope: "openid mail.modify" } })
    const connection = await test.runtime.complete({ code: "code-1", state })
    expect(connection).toMatchObject({ account: { email: "owner@example.com", id: "account-1" }, scopes: { missing: [] }, status: "connected" })

    const exchange = new URLSearchParams(test.provider.calls.at(-1)!.body)
    expect(exchange.get("grant_type")).toBe("authorization_code")
    expect(exchange.get("redirect_uri")).toBe("http://127.0.0.1:8976/callback")
    const challenge = base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(exchange.get("code_verifier")!)))
    expect(challenge).toBe(authorization.searchParams.get("code_challenge"))

    // A state is single use.
    expect(await rejection(test.runtime.complete({ code: "code-1", state }))).toMatchObject({ code: "CONNECTION_INVALID" })
  })

  it("rejects redirect URIs that are not HTTPS or loopback", async () => {
    const test = createTestRuntime()
    expect(await rejection(test.runtime.authorize({ name: "mail", redirectUri: "http://example.com/callback" }))).toMatchObject({ code: "CONNECTION_INVALID" })
  })

  it("keeps one account per Connection", async () => {
    const test = createTestRuntime()
    await connect(test)
    const error = await rejection(connect(test, { access_token: "other-access", id_token: "account-2", refresh_token: "other-refresh" }))
    expect(error).toMatchObject({ code: "CONNECTION_INVALID" })
    expect(test.provider.calls.at(-1)).toMatchObject({ body: "token=other-refresh", url: "https://auth.example.com/revoke" })
    expect(await test.runtime.inspect("mail")).toMatchObject({ account: { id: "account-1" } })
  })

  it("revokes the grant and blocks later calls", async () => {
    const test = createTestRuntime()
    await connect(test)
    expect(await test.runtime.revoke({ name: "mail" })).toMatchObject({ status: "revoked" })
    expect(test.provider.calls.at(-1)).toMatchObject({ body: `token=${REFRESH_TOKEN}`, url: "https://auth.example.com/revoke" })
    const error = await rejection(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" }))
    expect(error).toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
  })
})

describe("calls", () => {
  it("builds provider requests from the catalog", async () => {
    const test = createTestRuntime()
    await connect(test)
    const client = test.runtime.client("mail", {})
    expect(await client.call("mail.labels.list", { userId: "me" })).toEqual({ labels: [{ id: "INBOX" }] })
    expect(await client.call("mail.messages.modify", { id: "a/b", requestBody: { addLabelIds: ["L1"] }, userId: "me" })).toEqual({ id: "message-1" })
    const [list, modify] = test.provider.calls.slice(-2)
    expect(list).toMatchObject({ method: "GET", url: "https://mail.example.com/mail/v1/users/me/labels" })
    expect(list!.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(modify).toMatchObject({ body: "{\"addLabelIds\":[\"L1\"]}", method: "POST", url: "https://mail.example.com/mail/v1/users/me/messages/a%2Fb/modify" })
  })

  it("refreshes an expiring token once for concurrent calls", async () => {
    const test = createTestRuntime()
    await connect(test)
    test.now.value += 3600_000
    test.provider.valid = new Set(["access-2"])
    test.provider.tokenResponses.push({ body: { access_token: "access-2", expires_in: 3600 } })
    const client = test.runtime.client("mail", {})
    await Promise.all([client.call("mail.labels.list", { userId: "me" }), client.call("mail.labels.list", { userId: "me" })])
    expect(test.provider.calls.filter(call => call.url === "https://auth.example.com/token")).toHaveLength(2) // connect + one refresh
    const refresh = new URLSearchParams(test.provider.calls.find(call => call.body?.includes("grant_type=refresh_token"))!.body)
    expect(refresh.get("refresh_token")).toBe(REFRESH_TOKEN)
    // The refresh keeps the refresh token when the provider does not rotate it.
    test.now.value += 3600_000
    test.provider.valid = new Set(["access-3"])
    test.provider.tokenResponses.push({ body: { access_token: "access-3", expires_in: 3600 } })
    await client.call("mail.labels.list", { userId: "me" })
    expect(new URLSearchParams(test.provider.calls.filter(call => call.url === "https://auth.example.com/token").at(-1)!.body).get("refresh_token")).toBe(REFRESH_TOKEN)
  })

  it("uses the stored token when another isolate wins the refresh", async () => {
    const store = createStore()
    const first = createTestRuntime(mailConnection(), store)
    await connect(first)
    const second = createConnectionsRuntime({ definitions: { mail: mailConnection() }, fetch: first.provider.fetch, now: () => first.now.value, store })
    first.now.value += 3600_000
    first.provider.valid = new Set(["access-a", "access-b"])
    first.provider.tokenResponses.push({ body: { access_token: "access-a", expires_in: 3600 } }, { body: { access_token: "access-b", expires_in: 3600 } })
    await Promise.all([
      first.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" }),
      second.client("mail", {}).call("mail.labels.list", { userId: "me" }),
    ])
    const tokens = first.provider.calls.filter(call => call.url.startsWith("https://mail.example.com/")).map(call => call.headers.get("authorization"))
    // The losing isolate discards its token and uses the stored one.
    expect(new Set(tokens).size).toBe(1)
  })

  it("marks the Connection for reauthorization after invalid_grant", async () => {
    const test = createTestRuntime()
    await connect(test)
    test.now.value += 3600_000
    test.provider.tokenResponses.push({ body: { error: "invalid_grant" }, status: 400 })
    const error = await rejection(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" }))
    expect(error).toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
    expect(await test.runtime.inspect("mail")).toMatchObject({ status: "reauth_required" })
    const calls = test.provider.calls.length
    expect(await rejection(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" }))).toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
    expect(test.provider.calls).toHaveLength(calls)
  })

  it("refreshes and retries once after a 401", async () => {
    const test = createTestRuntime()
    await connect(test)
    test.provider.valid = new Set(["access-2"])
    test.provider.tokenResponses.push({ body: { access_token: "access-2", expires_in: 3600 } })
    expect(await test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })).toEqual({ labels: [{ id: "INBOX" }] })
  })

  it("keeps secrets out of errors and activity", async () => {
    const test = createTestRuntime()
    await connect(test)
    test.provider.valid = new Set()
    test.provider.tokenResponses.push({ body: { access_token: "access-2", expires_in: 3600 } })
    const error = await rejection(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" }))
    expect(error).toMatchObject({ code: "CONNECTION_PROVIDER", status: 401 })
    const activity = await test.runtime.activity({ name: "mail" })
    const serialized = JSON.stringify({ activity, error, message: (error as Error).message, stack: (error as Error).stack })
    for (const secret of [ACCESS_TOKEN, "access-2", REFRESH_TOKEN, CLIENT_SECRET]) expect(serialized).not.toContain(secret)
    expect(activity.some(entry => entry.operation === "mail.labels.list" && entry.outcome === "failed")).toBe(true)
  })

  it("sends fetch only to catalog origins", async () => {
    const test = createTestRuntime()
    await connect(test)
    const client = test.runtime.client("mail", {})
    expect((await client.fetch("https://mail.example.com/mail/v1/users/me/labels")).status).toBe(200)
    expect(await rejection(client.fetch("https://attacker.example.com/"))).toMatchObject({ code: "CONNECTION_INVALID" })
    expect(await rejection(client.fetch("https://mail.example.com/mail/v1/x", { body: "{}", method: "POST" }))).toMatchObject({ code: "CONNECTION_DENIED" })
  })
})

describe("policy", () => {
  it("allows declared writes for server code and asks approval for Agents by default", async () => {
    const test = createTestRuntime()
    await connect(test)
    await expect(test.runtime.client("mail", {}).call("mail.messages.modify", { id: "m1", userId: "me" })).resolves.toEqual({ id: "message-1" })
    expect(await rejection(test.runtime.client("mail", {}).call("mail.messages.send", { requestBody: { raw: "x" }, userId: "me" }))).toMatchObject({ code: "CONNECTION_DENIED" })
    await expect(test.runtime.client("mail", { actor: "agent:labeller" }).call("mail.labels.list", { userId: "me" })).resolves.toBeDefined()
    const error = await rejection(test.runtime.client("mail", { actor: "agent:labeller" }).call("mail.messages.modify", { id: "m1", userId: "me" }))
    expect(isConnectionError(error) && error.reason).toBe("approval_required")
  })

  it("denies actors that the access map does not list and records the denial", async () => {
    const test = createTestRuntime(mailConnection({
      "schedule:gmail": { read: true, write: ["mail.messages.modify"] },
    }))
    await connect(test)
    const scheduled = test.runtime.client("mail", { actor: "schedule:gmail", traceId: "trace-1" })
    await expect(scheduled.call("mail.messages.modify", { id: "m1", userId: "me" })).resolves.toEqual({ id: "message-1" })
    expect(await rejection(scheduled.call("mail.messages.send", { requestBody: { raw: "x" }, userId: "me" }))).toMatchObject({ code: "CONNECTION_DENIED" })
    const calls = test.provider.calls.length
    expect(await rejection(test.runtime.client("mail", { actor: "server" }).call("mail.labels.list", { userId: "me" }))).toMatchObject({ code: "CONNECTION_DENIED" })
    expect(test.provider.calls).toHaveLength(calls)
    const activity = await test.runtime.activity({ name: "mail" })
    expect(activity.filter(entry => entry.outcome === "denied").map(entry => ({ actor: entry.actor, operation: entry.operation }))).toEqual(expect.arrayContaining([
      { actor: { id: "server", kind: "service" }, operation: "mail.labels.list" },
      { actor: { id: "schedule:gmail", kind: "service" }, operation: "mail.messages.send" },
    ]))
    expect(activity.find(entry => entry.operation === "mail.messages.modify" && entry.outcome === "succeeded")).toMatchObject({ traceId: "trace-1" })
  })

  it("requires exact names for high-risk writes", async () => {
    const test = createTestRuntime(mailConnection({
      "server": { read: true, write: ["mail.messages.*"] },
      "schedule:send": { write: ["mail.messages.send"] },
    }))
    await connect(test)
    expect(await rejection(test.runtime.client("mail", {}).call("mail.messages.send", { requestBody: { raw: "x" }, userId: "me" }))).toMatchObject({ code: "CONNECTION_DENIED" })
    await expect(test.runtime.client("mail", { actor: "schedule:send" }).call("mail.messages.send", { requestBody: { raw: "x" }, userId: "me" })).resolves.toEqual({ id: "message-1" })
  })
})

describe("dry run", () => {
  it("reports writes without calling the provider", async () => {
    const test = createTestRuntime()
    await connect(test)
    const effects: ConnectionEffect[] = []
    const client = test.runtime.client("mail", { dryRun: true, onEffect: effect => effects.push(effect) })
    await expect(client.call("mail.labels.list", { userId: "me" })).resolves.toEqual({ labels: [{ id: "INBOX" }] })
    const calls = test.provider.calls.length
    await expect(client.call("mail.messages.modify", { id: "m1", requestBody: { addLabelIds: ["L1"] }, userId: "me" })).resolves.toBeUndefined()
    expect((await client.fetch("https://mail.example.com/x", { body: "{}", method: "POST" }).catch(error => error)).code).toBe("CONNECTION_DENIED")
    expect(test.provider.calls).toHaveLength(calls)
    expect(effects).toEqual([{
      kind: "mail.messages.modify",
      payload: { connection: "mail", input: { id: "m1", requestBody: { addLabelIds: ["L1"] }, userId: "me" }, method: "POST", url: "https://mail.example.com/mail/v1/users/me/messages/m1/modify" },
      read: false,
      skipped: "dry-run",
    }])
  })

  it("still denies writes that the policy denies", async () => {
    const test = createTestRuntime()
    await connect(test)
    const client = test.runtime.client("mail", { dryRun: true })
    expect(await rejection(client.call("mail.messages.send", { requestBody: { raw: "x" }, userId: "me" }))).toMatchObject({ code: "CONNECTION_DENIED" })
  })
})

describe("approvals", () => {
  it("replays an approved write once under the requesting actor", async () => {
    const test = createTestRuntime()
    await connect(test)
    const error = await rejection(test.runtime.client("mail", { actor: "agent:labeller", invocationId: "inv-1" }).call("mail.messages.modify", { id: "m1", requestBody: { addLabelIds: ["L1"] }, userId: "me" }))
    const id = isConnectionError(error) ? error.requestId! : ""
    expect((await test.runtime.approvals({ status: "pending" })).approvals).toEqual([expect.objectContaining({ action: "mail.messages.modify", actor: "agent:labeller", id, invocationId: "inv-1", name: "mail", status: "pending" })])
    const calls = test.provider.calls.length
    const approved = await test.runtime.approve({ actor: "user:owner", id })
    expect(approved).toMatchObject({ approval: { decidedBy: "user:owner", status: "executed" }, result: { id: "message-1" } })
    expect(test.provider.calls.slice(calls)).toEqual([expect.objectContaining({ body: "{\"addLabelIds\":[\"L1\"]}", method: "POST" })])
    expect(await rejection(test.runtime.approve({ id }))).toMatchObject({ code: "CONNECTION_INVALID" })
    const activity = await test.runtime.activity({ name: "mail" })
    expect(activity.find(entry => entry.operation === "mail.messages.modify" && entry.outcome === "succeeded")).toMatchObject({ actor: { id: "labeller", kind: "agent" }, invocationId: "inv-1" })
  })

  it("denies a pending write without calling the provider", async () => {
    const test = createTestRuntime()
    await connect(test)
    const error = await rejection(test.runtime.client("mail", { actor: "agent:labeller" }).call("mail.messages.modify", { id: "m1", userId: "me" }))
    const id = isConnectionError(error) ? error.requestId! : ""
    const calls = test.provider.calls.length
    expect(await test.runtime.deny({ actor: "user:owner", id })).toMatchObject({ decidedBy: "user:owner", status: "denied" })
    expect(test.provider.calls).toHaveLength(calls)
    expect(await rejection(test.runtime.approve({ id }))).toMatchObject({ code: "CONNECTION_INVALID" })
  })

  it("marks a failed replay", async () => {
    const test = createTestRuntime()
    await connect(test)
    const error = await rejection(test.runtime.client("mail", { actor: "agent:labeller" }).call("mail.messages.modify", { id: "m1", userId: "me" }))
    const id = isConnectionError(error) ? error.requestId! : ""
    await test.runtime.revoke({ name: "mail" })
    expect(await rejection(test.runtime.approve({ id }))).toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
    expect((await test.runtime.approvals({})).approvals).toEqual([expect.objectContaining({ error: "CONNECTION_REAUTH_REQUIRED", id, status: "failed" })])
  })
})
