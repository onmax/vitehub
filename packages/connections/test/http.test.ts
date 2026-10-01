import { describe, expect, it, vi } from "vitest"

import { createConnectionsHandler } from "../src/http.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { ACCESS_TOKEN, connect, createTestRuntime, mailConnection, REFRESH_TOKEN } from "./helpers.ts"

const origin = "http://localhost:5173"

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${origin}/_vitehub/connections`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin, ...headers },
    method: "POST",
  })
}

describe("createConnectionsHandler", () => {
  it("runs JSON actions for same-origin requests", async () => {
    const test = createTestRuntime()
    const handler = createConnectionsHandler({ runtime: () => test.runtime })
    const response = await handler(post({ action: "list" }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ connections: [{ name: "mail", provider: "example", status: "disconnected" }] })
  })

  it("dispatches and completes OAuth under an application base", async () => {
    const test = createTestRuntime()
    const handler = createConnectionsHandler({ basePath: "/portal/_vitehub/connections", runtime: () => test.runtime })
    const response = await handler(new Request(`${origin}/portal/_vitehub/connections`, {
      body: JSON.stringify({ action: "list" }), headers: { "content-type": "application/json", origin }, method: "POST",
    }))
    expect(response.status).toBe(200)
    const start = await handler(new Request(`${origin}/portal/_vitehub/connections/connect/mail`))
    expect(start.status).toBe(302)
    const location = new URL(start.headers.get("location")!)
    expect(location.searchParams.get("redirect_uri")).toBe(`${origin}/portal/_vitehub/connections/callback`)
    expect(start.headers.get("set-cookie")).toContain("Path=/portal/_vitehub/connections;")
    const state = location.searchParams.get("state")!
    test.provider.tokenResponses.push({ body: { access_token: ACCESS_TOKEN, id_token: "account-1", refresh_token: REFRESH_TOKEN } })
    const callback = await handler(new Request(`${origin}/portal/_vitehub/connections/callback?code=code-1&state=${state}`, {
      headers: { cookie: `vitehub_connection_state=${state}` },
    }))
    expect(callback.status).toBe(200)
    expect(callback.headers.get("set-cookie")).toContain("Path=/portal/_vitehub/connections;")
  })

  it("returns approval summaries without stored provider input", async () => {
    const test = createTestRuntime()
    await test.store.approvals.create({ action: "mail.messages.modify", actor: "agent:mail", createdAt: new Date().toISOString(), id: "private-approval", input: { body: "private-message-content", recipient: "private@example.com" }, name: "mail", status: "pending" })
    const handler = createConnectionsHandler({ runtime: () => test.runtime })
    for (const action of ["approvals", "deny"]) {
      const response = await handler(post(action === "approvals" ? { action, name: "mail" } : { action, id: "private-approval" }))
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).not.toContain("private-message-content")
      expect(text).not.toContain("private@example.com")
      expect(text).not.toContain('"input"')
      expect(text).toContain("private-approval")
    }
    expect(await test.store.approvals.get("private-approval")).toMatchObject({ input: { body: "private-message-content" } })
  })

  it("returns only the approval summary after a successful provider write", async () => {
    const test = createTestRuntime()
    const privateRecord = { id: "private-message-id", body: "private-provider-message", recipient: "private-recipient@example.com" }
    test.runtime = createConnectionsRuntime({
      definitions: { mail: mailConnection() },
      fetch: async (input, init) => {
        const response = await test.provider.fetch(input, init)
        return String(input).endsWith("/modify") ? Response.json(privateRecord) : response
      },
      now: () => test.now.value,
      store: test.store,
    })
    await connect(test)
    await expect(test.runtime.client("mail", { actor: "agent:labeller" }).call("mail.messages.modify", {
      id: "m1", requestBody: { addLabelIds: ["private-input-label"] }, userId: "me",
    })).rejects.toMatchObject({ code: "CONNECTION_APPROVAL_REQUIRED" })
    const pending = (await test.runtime.approvals({ status: "pending" })).approvals[0]!
    const approve = vi.spyOn(test.runtime, "approve")
    const handler = createConnectionsHandler({ actor: () => "user:owner", runtime: () => test.runtime })
    const response = await handler(post({ action: "approve", id: pending.id }))
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ approval: expect.objectContaining({ id: pending.id, status: "executed", decidedBy: "user:owner" }) })
    for (const privateValue of [...Object.values(privateRecord), "private-input-label", '"result"', '"input"']) expect(text).not.toContain(privateValue)
    expect(await approve.mock.results[0]!.value).toMatchObject({ result: privateRecord })
    expect(await test.store.approvals.get(pending.id)).toMatchObject({ status: "executed", input: { input: { requestBody: { addLabelIds: ["private-input-label"] } } } })
  })

  it("pages every pending approval without unbounded reads or decision gaps", async () => {
    const test = createTestRuntime()
    for (let index = 0; index < 205; index++) {
      await test.store.approvals.create({ action: "mail.messages.modify", actor: "agent:mail", createdAt: new Date().toISOString(), id: `approval-${index}`, input: {}, name: "mail", status: "pending" })
    }
    const handler = createConnectionsHandler({ runtime: () => test.runtime })
    const page = async (before?: string) => {
      const response = await handler(post({ action: "approvals", name: "mail", status: "pending", ...(before ? { before } : {}) }))
      expect(response.status).toBe(200)
      // SAFETY: The real local handler serializes an approval page from SQLite.
      return await response.json() as { approvals: Array<{ id: string }>, nextCursor?: string }
    }
    const first = await page()
    expect(first.approvals).toHaveLength(100)
    expect(first.nextCursor).toBe("approval-105")
    // Decisions remove rows from the pending filter, but cannot shift the cursor.
    expect((await handler(post({ action: "deny", id: first.nextCursor }))).status).toBe(200)
    const second = await page(first.nextCursor)
    expect(second.approvals).toHaveLength(100)
    expect(second.nextCursor).toBe("approval-5")
    const third = await page(second.nextCursor)
    expect(third.approvals).toHaveLength(5)
    expect(third.nextCursor).toBeUndefined()
    const discovered = [...first.approvals, ...second.approvals, ...third.approvals].map(approval => approval.id)
    expect(new Set(discovered).size).toBe(205)
    expect(discovered).toContain("approval-0")
    const denied = await handler(post({ action: "deny", id: "approval-0" }))
    expect(denied.status).toBe(200)
    expect(await test.store.approvals.get("approval-0")).toMatchObject({ status: "denied" })
    expect((await test.runtime.approvals({})).approvals).toHaveLength(100)
  })

  it("returns grouped pending counts without loading approval inputs", async () => {
    const test = createTestRuntime()
    for (let index = 0; index < 205; index++) {
      await test.store.approvals.create({ action: "mail.messages.modify", actor: "agent:mail", createdAt: new Date().toISOString(), id: `approval-${index}`, input: { body: "private-call-input".repeat(100) }, name: "mail", status: "pending" })
    }
    await test.store.approvals.create({ action: "removed.messages.modify", actor: "agent:removed", createdAt: new Date().toISOString(), id: "removed", input: {}, name: "removed", status: "pending" })
    await test.store.approvals.transition("approval-0", "pending", "denied")
    const list = vi.spyOn(test.store.approvals, "list")
    const handler = createConnectionsHandler({ runtime: () => test.runtime })
    const response = await handler(post({ action: "approval-counts" }))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(JSON.stringify({ counts: { mail: 204 } }))
    expect(list).not.toHaveBeenCalled()
  })

  it("rejects cross-origin, non-JSON, and invalid requests", async () => {
    const test = createTestRuntime()
    const handler = createConnectionsHandler({ runtime: () => test.runtime })
    expect((await handler(post({ action: "list" }, { origin: "https://attacker.example.com" }))).status).toBe(403)
    expect((await handler(post({ action: "list" }, { "sec-fetch-site": "cross-site" }))).status).toBe(403)
    expect((await handler(post({ action: "list" }, { "content-type": "text/plain" }))).status).toBe(403)
    expect((await handler(post({ action: "drop" }))).status).toBe(400)
    expect((await handler(new Request(`${origin}/_vitehub/connections`))).status).toBe(405)
  })

  it("maps Connection errors to HTTP statuses", async () => {
    const test = createTestRuntime()
    const handler = createConnectionsHandler({ runtime: () => test.runtime })
    const response = await handler(post({ action: "inspect", name: "missing" }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "CONNECTION_INVALID" } })
    expect((await handler(post({ action: "approve", id: "approval_missing" }))).status).toBe(400)
  })

  it("completes the web authorization flow with a state cookie", async () => {
    const test = createTestRuntime()
    const handler = createConnectionsHandler({ actor: () => "user:owner", runtime: () => test.runtime })
    const start = await handler(new Request(`${origin}/_vitehub/connections/connect/mail`))
    expect(start.status).toBe(302)
    const location = new URL(start.headers.get("location")!)
    expect(location.searchParams.get("redirect_uri")).toBe(`${origin}/_vitehub/connections/callback`)
    const state = location.searchParams.get("state")!
    const cookie = start.headers.get("set-cookie")!
    expect(cookie).toContain(`vitehub_connection_state=${state}`)
    expect(cookie).toContain("HttpOnly")

    const mismatch = await handler(new Request(`${origin}/_vitehub/connections/callback?code=code-1&state=${state}`))
    expect(mismatch.status).toBe(400)

    test.provider.tokenResponses.push({ body: { access_token: ACCESS_TOKEN, expires_in: 3600, id_token: "account-1", refresh_token: REFRESH_TOKEN, scope: "mail.modify" } })
    const callback = await handler(new Request(`${origin}/_vitehub/connections/callback?code=code-1&state=${state}`, {
      headers: { cookie: `vitehub_connection_state=${state}` },
    }))
    expect(callback.status).toBe(200)
    const html = await callback.text()
    expect(html).toContain("owner@example.com")
    expect(html).not.toContain(ACCESS_TOKEN)
    expect(callback.headers.get("set-cookie")).toContain("Max-Age=0")
    expect(await test.runtime.inspect("mail")).toMatchObject({ status: "connected" })
    const activity = await test.runtime.activity({ name: "mail" })
    expect(activity.find(entry => entry.action === "replace")).toMatchObject({ actor: { id: "owner", kind: "user" } })
  })
})
