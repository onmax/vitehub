import { describe, expect, it, vi } from "vitest"

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

})
