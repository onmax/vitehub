import { describe, expect, it, vi } from "vitest"

import { oauth2 } from "../src/providers/oauth2.ts"

import { fakeProvider, readOperation, setupRuntime, tokenSet, writeOperation } from "./helpers.ts"

describe("Connection Operation cancellation", () => {
  it.each(["read", "write"])("aborts an in-flight %s Operation fetch when its call signal is cancelled", async (effect) => {
    const controller = new AbortController()
    let started: (() => void) | undefined
    const fetching = new Promise<void>(resolve => started = resolve)
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      started?.()
    }))
    const { name, runtime, store } = setupRuntime({ definition: { access: { server: { allow: ["*"] } }, provider: fakeProvider().provider }, fetch })
    await store.write({ name, provider: "fake", tokens: tokenSet() })
    const options = { actor: { id: "server", kind: "service" as const }, signal: controller.signal }
    const pending = effect === "read"
      ? runtime.call(name, readOperation, { id: "42" }, options)
      : runtime.call(name, writeOperation, { name: "draft" }, options)
    await fetching
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal)
    controller.abort(new Error("tool cancelled"))
    await expect(pending).rejects.toBe(controller.signal.reason)
  })

  it.each(["initial", "forced"])("cancels the %s OAuth refresh without sending another API request", async (phase) => {
    const controller = new AbortController()
    let started: (() => void) | undefined
    const refreshing = new Promise<void>(resolve => started = resolve)
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(input) === "https://auth.example/token") {
        started?.()
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        })
      }
      return Promise.resolve(new Response(null, { status: 401 }))
    })
    const provider = oauth2({
      authorizationUrl: "https://auth.example/authorize",
      client: () => ({ clientId: "client" }),
      id: "fake",
      origins: ["https://api.example"],
      scopes: ["test.read"],
      tokenUrl: "https://auth.example/token",
    })
    const { name, runtime, store } = setupRuntime({ definition: { provider }, fetch })
    const original = tokenSet({ expiresAt: phase === "initial" ? Date.now() - 1 : Date.now() + 3_600_000 })
    await store.write({ name, provider: "fake", tokens: original })
    const pending = runtime.call(name, readOperation, { id: "42" }, { actor: { id: "server", kind: "service" }, signal: controller.signal })
    await refreshing
    expect(fetch.mock.calls.at(-1)?.[1]?.signal).toBe(controller.signal)
    controller.abort(new Error("refresh cancelled"))
    await expect(pending).rejects.toBe(controller.signal.reason)
    expect(fetch).toHaveBeenCalledTimes(phase === "initial" ? 1 : 2)
    expect((await store.tokens(name))?.tokens).toEqual(original)
    expect(await runtime.inspect(name)).toMatchObject({ status: "active" })
    // Cancellation releases the lease so a later call can acquire it.
    const grant = await store.grant(name)
    expect(await store.lease(name, grant!.revision, Date.now(), Date.now() + 30_000)).toBe(true)
  })

  it("cancels a refresh lease wait without changing the lease owner's grant", async () => {
    const controller = new AbortController()
    const fake = fakeProvider()
    const { name, runtime, store } = setupRuntime({ definition: { provider: fake.provider } })
    const grant = await store.write({ name, provider: "fake", tokens: tokenSet({ expiresAt: Date.now() - 1 }) })
    await store.lease(name, grant.revision, Date.now(), Date.now() + 30_000)
    const leasedGrant = await store.grant(name)
    const pending = runtime.call(name, readOperation, { id: "42" }, { actor: { id: "server", kind: "service" }, signal: controller.signal })
    // The runtime has a separate Store instance, so observe the lease wait through its timer.
    const timer = vi.spyOn(globalThis, "setTimeout")
    await vi.waitFor(() => expect(timer).toHaveBeenCalledWith(expect.any(Function), 50), { interval: 10 })
    timer.mockRestore()
    controller.abort(new Error("lease wait cancelled"))
    await expect(pending).rejects.toBe(controller.signal.reason)
    expect(fake.refresh).not.toHaveBeenCalled()
    expect(await store.grant(name)).toEqual(leasedGrant)
    expect(await store.lease(name, grant.revision, Date.now(), Date.now() + 30_000)).toBe(false)
  })

  it("does not persist a custom provider refresh that finishes after cancellation", async () => {
    const controller = new AbortController()
    let started: (() => void) | undefined
    let finish: (() => void) | undefined
    const refreshing = new Promise<void>(resolve => started = resolve)
    const refreshed = new Promise<void>(resolve => finish = resolve)
    const provider = fakeProvider({ refresh: async (token, context) => {
      expect(context.signal).toBe(controller.signal)
      started?.()
      await refreshed
      return { ...token, accessToken: "late-token" }
    } }).provider
    const { name, runtime, store } = setupRuntime({ definition: { provider } })
    const original = tokenSet({ expiresAt: Date.now() - 1 })
    await store.write({ name, provider: "fake", tokens: original })
    const pending = runtime.call(name, readOperation, { id: "42" }, { actor: { id: "server", kind: "service" }, signal: controller.signal })
    await refreshing
    controller.abort(new Error("refresh cancelled"))
    await expect(pending).rejects.toBe(controller.signal.reason)
    finish?.()
    expect((await store.tokens(name))?.tokens).toEqual(original)
  })

})
