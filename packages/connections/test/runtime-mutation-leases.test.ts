import { expect, it } from "vitest"

import { defineConnection } from "../src/definition.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { connect, createTestRuntime, mailConnection, testProvider } from "./helpers.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it("waits for grant-wide revocation before exchanging a concurrent callback", async () => {
  const test = createTestRuntime()
  await connect(test)
  const entered = deferred()
  const release = deferred()
  const providerFetch: typeof fetch = async (input, init) => {
    if (String(input) === "https://auth.example.com/revoke") {
      entered.resolve()
      await release.promise
      test.provider.valid.clear()
    }
    const response = await test.provider.fetch(input, init)
    if (String(input) === "https://auth.example.com/token") test.provider.valid.add("reconnected-access")
    return response
  }
  const options = { definitions: { mail: mailConnection() }, fetch: providerFetch, now: () => test.now.value, store: test.store }
  const first = createConnectionsRuntime(options)
  const second = createConnectionsRuntime({ ...options, store: { ...test.store } })
  const revoking = first.revoke({ name: "mail" })
  await entered.promise
  const reconnecting = connect({ ...test, runtime: second }, { access_token: "reconnected-access", refresh_token: "reconnected-refresh" })
  let exchangesWhileRevoking: number
  try {
    await new Promise(resolve => setTimeout(resolve, 50))
    exchangesWhileRevoking = test.provider.calls.filter(call => call.url === "https://auth.example.com/token").length
  }
  finally {
    release.resolve()
  }
  const results = await Promise.allSettled([revoking, reconnecting])
  expect(exchangesWhileRevoking).toBe(1)
  expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"])
  expect(await second.inspect("mail")).toMatchObject({ status: "connected" })
  await expect(second.client("mail", {}).call("mail.labels.list", { userId: "me" })).resolves.toMatchObject({ labels: [{ id: "INBOX" }] })
})

it("keeps an unresolved expired revoke lease after the token revision changes", async () => {
  const test = createTestRuntime()
  await connect(test)
  const token = await test.store.secrets.read("connection/mail")
  if (!token?.revision) throw new Error("Expected connected token revision")
  await test.store.refreshLeases.claim({ expiresAt: test.now.value + 10, name: "mail", now: test.now.value, owner: "unresolved-revoke", revision: token.revision })
  await test.store.secrets.replace({ expectedRevision: token.revision, key: "connection/mail", value: token.value })
  test.now.value += 11
  const before = test.provider.calls.length
  await expect(connect(test, { access_token: "new-access" })).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
  expect(test.provider.calls).toHaveLength(before)
  expect(await test.store.refreshLeases.claim({ expiresAt: test.now.value + 100, name: "mail", now: test.now.value, owner: "late-callback", revision: "another-revision" })).toBe("expired")
})


it("waits for callback persistence before revoking its newly issued grant", async () => {
  const test = createTestRuntime()
  await connect(test)
  const entered = deferred()
  const release = deferred()
  const providerFetch: typeof fetch = async (input, init) => {
    if (String(input) === "https://auth.example.com/token") {
      entered.resolve()
      await release.promise
    }
    return await test.provider.fetch(input, init)
  }
  const options = { definitions: { mail: mailConnection() }, fetch: providerFetch, now: () => test.now.value, store: test.store }
  const first = createConnectionsRuntime(options)
  const second = createConnectionsRuntime({ ...options, store: { ...test.store } })
  const callback = connect({ ...test, runtime: first }, { access_token: "next-access", refresh_token: "next-refresh" })
  await entered.promise
  const revoking = second.revoke({ name: "mail" })
  let prematureRevokes: number
  try {
    await new Promise(resolve => setTimeout(resolve, 50))
    prematureRevokes = test.provider.calls.filter(call => call.url === "https://auth.example.com/revoke").length
  }
  finally { release.resolve() }
  await Promise.all([callback, revoking])
  expect(prematureRevokes).toBe(0)
  expect(test.provider.calls.at(-1)).toMatchObject({ body: "token=next-refresh", url: "https://auth.example.com/revoke" })
  expect(await second.inspect("mail")).toMatchObject({ status: "revoked" })
})

it("retains an unconfirmed revoke lease instead of reconnecting while the provider may still revoke", async () => {
  const test = createTestRuntime()
  await connect(test)
  const providerFetch: typeof fetch = async (input, init) => {
    if (String(input) === "https://auth.example.com/revoke") throw new TypeError("Provider response lost")
    return await test.provider.fetch(input, init)
  }
  const runtime = createConnectionsRuntime({ definitions: { mail: mailConnection() }, fetch: providerFetch, now: () => test.now.value, store: test.store })
  await expect(runtime.revoke({ name: "mail" })).rejects.toBeDefined()
  const before = test.provider.calls.length
  test.now.value += 60_001
  await expect(connect({ ...test, runtime })).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
  expect(test.provider.calls).toHaveLength(before)
})

it("releases a settled rejected callback so a later authorization can succeed", async () => {
  const test = createTestRuntime()
  const { state } = await test.runtime.authorize({ name: "mail", redirectUri: "http://127.0.0.1:8976/callback" })
  await expect(test.runtime.complete({ code: "invalid-code", state })).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
  await connect(test)
  expect(await test.runtime.inspect("mail")).toMatchObject({ status: "connected" })
})


it("quarantines the old grant when callback replacement cannot be persisted", async () => {
  const test = createTestRuntime()
  await connect(test)
  const replace = test.store.bridge.replace
  test.store.bridge.replace = () => Promise.reject(new Error("Callback persistence unavailable"))
  await expect(connect(test, { access_token: "rotated-by-callback", refresh_token: "rotated-refresh" })).rejects.toThrow("Callback persistence unavailable")
  test.store.bridge.replace = replace
  expect(await test.runtime.inspect("mail")).toMatchObject({ status: "reauth_required" })
  const before = test.provider.calls.length
  await expect(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
  test.now.value += 60_001
  await expect(connect(test)).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
  expect(test.provider.calls).toHaveLength(before)
})

it("retains the lease when callback exchange returns an unreadable issued grant", async () => {
  const test = createTestRuntime()
  await connect(test)
  const runtime = createConnectionsRuntime({ definitions: { mail: mailConnection() }, store: test.store, now: () => test.now.value, fetch: async (input, init) => {
    if (String(input) === "https://auth.example.com/token") return new Response("truncated token response", { status: 200 })
    return await test.provider.fetch(input, init)
  } })
  await expect(connect({ ...test, runtime })).rejects.toMatchObject({ code: "CONNECTION_PROVIDER" })
  expect(await runtime.inspect("mail")).toMatchObject({ status: "reauth_required" })
  test.now.value += 60_001
  await expect(connect({ ...test, runtime })).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
})


it("rejects unsupported provider revocation without discarding the connected grant", async () => {
  const test = createTestRuntime(async () => ({ default: defineConnection({ provider: { ...testProvider(), revocationEndpoint: undefined }, scopes: ["mail.modify"] }) }))
  await connect(test)
  const before = await test.store.secrets.read("connection/mail")
  await expect(test.runtime.revoke({ name: "mail" })).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
  expect(await test.store.secrets.read("connection/mail")).toEqual(before)
  expect(await test.runtime.inspect("mail")).toMatchObject({ status: "connected", account: { id: "account-1" } })
  expect(test.provider.calls.filter(call => call.url === "https://auth.example.com/revoke")).toEqual([])
})

it.each(["account", "secret read", "state read"] as const)("quarantines a replaced provider grant when callback %s fails", async stage => {
  const provider = testProvider()
  let failAccount = false
  const definition = defineConnection({
    provider: { ...provider, account: response => {
      if (failAccount) throw new Error("Callback account unavailable")
      return provider.account(response)
    } },
    scopes: ["mail.modify"],
  })
  const test = createTestRuntime(async () => ({ default: definition }))
  await connect(test)
  const original = await test.store.secrets.read("connection/mail")
  const read = test.store.secrets.read
  const get = test.store.state.get
  const runtime = createConnectionsRuntime({ definitions: { mail: async () => ({ default: definition }) }, store: test.store, now: () => test.now.value, fetch: async (input, init) => {
    const response = await test.provider.fetch(input, init)
    if (String(input) === "https://auth.example.com/token") {
      test.provider.valid.clear()
      test.provider.valid.add("rotated-by-callback")
      failAccount = stage === "account"
      if (stage === "secret read") test.store.secrets.read = async () => { test.store.secrets.read = read; throw new Error("Callback secret read unavailable") }
      if (stage === "state read") test.store.state.get = async () => { test.store.state.get = get; throw new Error("Callback state read unavailable") }
    }
    return response
  } })
  const callbackRuntime = runtime
  try {
    await expect(connect({ ...test, runtime: callbackRuntime }, { access_token: "rotated-by-callback", refresh_token: "rotated-refresh" })).rejects.toThrow("Callback")
  }
  finally { test.store.secrets.read = read; test.store.state.get = get; failAccount = false }
  expect(await test.store.secrets.read("connection/mail")).toEqual(original)
  expect(await callbackRuntime.inspect("mail")).toMatchObject({ status: "reauth_required", account: { id: "account-1" } })
  const before = test.provider.calls.length
  await expect(callbackRuntime.client("mail", {}).call("mail.labels.list", { userId: "me" })).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
  test.now.value += 60_001
  await expect(connect({ ...test, runtime: callbackRuntime })).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
  expect(test.provider.calls).toHaveLength(before)
})
