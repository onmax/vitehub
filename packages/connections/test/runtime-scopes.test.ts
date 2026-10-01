import { expect, it } from "vitest"

import { gmailOperations } from "../src/providers/gmail.ts"
import { fakeProvider, mockFetch, readOperation, setupRuntime, tokenSet, writeOperation } from "./helpers.ts"

const actor = { id: "server", kind: "service" } as const

it("requires reconnect before dispatch when the old grant lacks the Operation scope", async () => {
  const api = mockFetch(() => Response.json({ id: "message-1", threadId: "thread-1" }))
  const readonlyScope = "https://www.googleapis.com/auth/gmail.readonly"
  const modifyScope = "https://www.googleapis.com/auth/gmail.modify"
  const provider = fakeProvider({ origins: ["https://gmail.googleapis.com"], scopes: [readonlyScope, modifyScope] })
  const { name, runtime, store } = setupRuntime({
    definition: { access: { server: { allow: ["*"] } }, provider: provider.provider },
    fetch: api.fetch,
  })
  await store.write({ name, provider: "fake", tokens: tokenSet({ expiresAt: Date.now() - 1, scopes: [readonlyScope] }) })
  await expect(runtime.call(name, gmailOperations.messagesModify, { id: "message-1", addLabelIds: ["INBOX"] }, { actor })).rejects.toMatchObject({ code: "CONNECTIONS_NEEDS_RECONNECT" })
  expect(api.calls).toEqual([])
  expect(provider.refresh).not.toHaveBeenCalled()
  expect(await runtime.inspect(name)).toMatchObject({ status: "needs-reconnect", lastError: "CONNECTIONS_SCOPES_CHANGED" })
  expect(await runtime.activity({})).toEqual([expect.objectContaining({ error: "CONNECTIONS_NEEDS_RECONNECT", operation: gmailOperations.messagesModify.id, outcome: "failed" })])
  await store.write({ name, provider: "fake", tokens: tokenSet({ scopes: [readonlyScope, modifyScope] }) })
  await expect(runtime.call(name, gmailOperations.messagesModify, { id: "message-1", addLabelIds: ["INBOX"] }, { actor })).resolves.toMatchObject({ id: "message-1" })
  expect(api.calls).toHaveLength(1)
  expect(await runtime.inspect(name)).toMatchObject({ status: "active" })
})

it.each(["test.read", "test.write"])("accepts an Operation when its grant contains the alternative scope %s", async (scope) => {
  const api = mockFetch(() => Response.json({ id: "42", ok: true }))
  const { name, runtime, store } = setupRuntime({ fetch: api.fetch })
  await store.write({ name, provider: "fake", tokens: tokenSet({ scopes: [scope] }) })
  await expect(runtime.call(name, { ...readOperation, scopes: ["test.read", "test.write"] }, { id: "42" }, { actor })).resolves.toMatchObject({ ok: true })
  expect(api.calls).toHaveLength(1)
})

it("checks the refreshed grant before sending an Operation", async () => {
  const api = mockFetch(() => Response.json({ created: "x" }))
  const provider = fakeProvider({ refresh: async token => ({ ...token, expiresAt: Date.now() + 3_600_000, scopes: ["test.read"] }) })
  const { name, runtime, store } = setupRuntime({ definition: { access: { server: { allow: ["*"] } }, provider: provider.provider }, fetch: api.fetch })
  await store.write({ name, provider: "fake", tokens: tokenSet({ expiresAt: Date.now() - 1 }) })
  await expect(runtime.call(name, { ...writeOperation, scopes: ["test.write"] }, { name: "x" }, { actor })).rejects.toMatchObject({ code: "CONNECTIONS_NEEDS_RECONNECT" })
  expect(api.calls).toEqual([])
})

it("checks scopes again before the API retry after a 401 refresh", async () => {
  const api = mockFetch(() => Response.json({ error: "unauthorized" }, { status: 401 }))
  const provider = fakeProvider({ refresh: async token => ({ ...token, scopes: ["test.read"] }) })
  const { name, runtime, store } = setupRuntime({ definition: { access: { server: { allow: ["*"] } }, provider: provider.provider }, fetch: api.fetch })
  await store.write({ name, provider: "fake", tokens: tokenSet() })
  await expect(runtime.call(name, { ...writeOperation, scopes: ["test.write"] }, { name: "x" }, { actor })).rejects.toMatchObject({ code: "CONNECTIONS_NEEDS_RECONNECT" })
  expect(api.calls).toHaveLength(1)
})
