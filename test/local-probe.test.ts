import { afterEach, expect, it, vi } from "vitest"

import { waitForProbe } from "./local/probe.mjs"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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

it("does not wait for response body cleanup past the deadline", async () => {
  const body = { cancel: vi.fn(() => new Promise(() => {})) }
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body })))
  const result = await Promise.race([
    waitForProbe("http://localhost", 20).then(() => "ready", (error: Error) => error.message),
    new Promise(resolve => setTimeout(resolve, 250, "still waiting")),
  ])
  expect(result).toBe("ready")
  expect(body.cancel).toHaveBeenCalledOnce()
})

it("subtracts fetch time from the response body cleanup budget", async () => {
  vi.spyOn(Date, "now")
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(0)
    .mockReturnValue(80)
  const body = { cancel: vi.fn(() => new Promise(() => {})) }
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body })))
  const result = await Promise.race([
    waitForProbe("http://localhost", 100).then(() => "ready"),
    new Promise(resolve => setTimeout(resolve, 75, "still waiting")),
  ])
  expect(result).toBe("ready")
  expect(body.cancel).toHaveBeenCalledOnce()
})
