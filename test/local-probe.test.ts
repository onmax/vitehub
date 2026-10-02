import { afterEach, expect, it, vi } from "vitest"

import { waitForProbe } from "./local/probe.mjs"

afterEach(() => {
  vi.unstubAllGlobals()
})

it("aborts a stalled fetch at the overall readiness deadline", async () => {
  let aborted = false
  vi.stubGlobal("fetch", vi.fn((_url: URL, options?: RequestInit) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => {
      aborted = true
      reject(options.signal?.reason)
    }, { once: true })
  })))
  const result = await Promise.race([
    waitForProbe("http://localhost", 20).then(() => "ready", (error: Error) => error.message),
    new Promise(resolve => setTimeout(resolve, 250, "still waiting")),
  ])
  expect(result).toContain("never became healthy")
  expect(aborted).toBe(true)
})

it("returns on a healthy response", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null)))
  await expect(waitForProbe("http://localhost", 20)).resolves.toBeUndefined()
})
