import { mockEvent } from "h3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { cloudflareRateLimitDriver } from "../src/drivers/cloudflare.ts"
import { memoryRateLimitDriver } from "../src/drivers/memory.ts"
import { createRateLimiter, peekRateLimit, requireRateLimit, resetRateLimit } from "../src/index.ts"
import { setRateLimitRuntimeConfig } from "../src/runtime.ts"

import type { H3Event } from "h3"
import type { RateLimitDriver } from "../src/index.ts"

const now = Date.parse("2026-05-22T09:00:30.000Z")
const windowEnd = Date.parse("2026-05-22T09:01:00.000Z")

function requestEvent(clientAddress: string): H3Event {
  const event = mockEvent("https://example.com/login")
  Object.assign(event.req, { ip: clientAddress })
  return event
}

const capabilities = { enforcement: "strict", rejectedAttempts: "not-counted", scope: "process" } as const

describe("Rate Limiter peek and reset", () => {
  it("reads a memory counter without consuming a token and deletes it on reset", async () => {
    let timestamp = now
    const limiter = createRateLimiter({ driver: memoryRateLimitDriver({ now: () => timestamp }), limit: 2, name: "login", window: "1m" })

    await expect(limiter.peek({ key: "user-1" })).resolves.toEqual({ limit: 2, remaining: 2, status: "known", used: 0, windowMs: 60_000 })
    await limiter.consume({ key: "user-1" })
    await expect(limiter.peek({ key: "user-1" })).resolves.toEqual({ limit: 2, remaining: 1, resetAt: windowEnd, status: "known", used: 1, windowMs: 60_000 })
    await expect(limiter.peek({ key: "user-1" })).resolves.toMatchObject({ used: 1 })
    await expect(limiter.consume({ key: "user-1" })).resolves.toMatchObject({ allowed: true, remaining: 0 })
    await expect(limiter.consume({ key: "user-1" })).resolves.toMatchObject({ allowed: false })

    await expect(limiter.reset({ key: "user-1" })).resolves.toEqual({ status: "reset" })
    await expect(limiter.peek({ key: "user-1" })).resolves.toMatchObject({ remaining: 2, used: 0 })
    await expect(limiter.consume({ key: "user-1" })).resolves.toMatchObject({ allowed: true, used: 1 })

    timestamp = windowEnd
    await expect(limiter.peek({ key: "user-1" })).resolves.toEqual({ limit: 2, remaining: 2, status: "known", used: 0, windowMs: 60_000 })
  })

  it("keeps counters of other names and keys", async () => {
    const driver = memoryRateLimitDriver({ now: () => now })
    const login = createRateLimiter({ driver, limit: 5, name: "login", window: "1m" })
    const upload = createRateLimiter({ driver, limit: 5, name: "upload", window: "1m" })
    await login.consume({ key: "user-1" })
    await login.consume({ key: "user-2" })
    await upload.consume({ key: "user-1" })

    await login.reset({ key: "user-1" })

    await expect(login.peek({ key: "user-1" })).resolves.toMatchObject({ used: 0 })
    await expect(login.peek({ key: "user-2" })).resolves.toMatchObject({ used: 1 })
    await expect(upload.peek({ key: "user-1" })).resolves.toMatchObject({ used: 1 })
  })

  it("reports unsupported when the driver cannot read or reset counters", async () => {
    const binding = { limit: vi.fn(async () => ({ success: true })) }
    const limiter = createRateLimiter({ driver: cloudflareRateLimitDriver({ binding }), limit: 5, window: "1m" })

    await expect(limiter.peek({ key: "user-1" })).resolves.toEqual({
      limit: 5,
      reason: "The \"cloudflare\" Rate Limit driver cannot read a counter without consuming a token.",
      status: "unsupported",
      windowMs: 60_000,
    })
    await expect(limiter.reset({ key: "user-1" })).resolves.toEqual({
      reason: "The \"cloudflare\" Rate Limit driver cannot reset a counter.",
      status: "unsupported",
    })
    expect(binding.limit).not.toHaveBeenCalled()
  })

  it("reports driver outages and rejects invalid driver results and keys", async () => {
    const outage = new Error("store offline")
    const driver: RateLimitDriver = {
      capabilities,
      consume: () => [null, { allowed: true }],
      name: "custom",
      peek: () => [outage, undefined],
      reset: () => [outage],
    }
    const limiter = createRateLimiter({ driver, limit: 5, window: "1m" })
    await expect(limiter.peek({ key: "user-1" })).resolves.toEqual({ cause: outage, limit: 5, status: "unavailable", windowMs: 60_000 })
    await expect(limiter.reset({ key: "user-1" })).resolves.toEqual({ cause: outage, status: "unavailable" })
    await expect(limiter.peek({ key: "" })).rejects.toThrow("peek() requires a non-empty key")
    await expect(limiter.reset({ key: "" })).rejects.toThrow("reset() requires a non-empty key")

    const invalid = createRateLimiter({ driver: { ...driver, peek: () => [null, { used: -1 }] }, limit: 5, window: "1m" })
    await expect(invalid.peek({ key: "user-1" })).rejects.toThrow("non-negative integer used count")
  })
})

describe("managed Rate Limit counters", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    setRateLimitRuntimeConfig({ provider: "memory" })
  })

  afterEach(() => {
    vi.useRealTimers()
    setRateLimitRuntimeConfig({ provider: "memory" })
  })

  it("reads the counters of requireRateLimit() without consuming a token", async () => {
    await expect(peekRateLimit("login", "192.0.2.1")).resolves.toEqual({
      key: "192.0.2.1",
      name: "login",
      provider: "memory",
      reason: "No request used this Rate Limit in this process since it started, so no counter exists.",
      status: "unused",
    })

    await requireRateLimit(requestEvent("192.0.2.1"), "login", { limit: 2, window: "1m" })
    const known = {
      counters: [{ limit: 2, remaining: 1, resetAt: windowEnd, used: 1, window: "1m", windowMs: 60_000 }],
      key: "192.0.2.1",
      name: "login",
      provider: "memory",
      scope: "process",
      status: "known",
    }
    await expect(peekRateLimit("login", "192.0.2.1")).resolves.toEqual(known)
    await expect(peekRateLimit("login", "192.0.2.1")).resolves.toEqual(known)
    await expect(peekRateLimit("login", "192.0.2.2")).resolves.toMatchObject({ counters: [{ remaining: 2, used: 0 }], status: "known" })

    await requireRateLimit(requestEvent("192.0.2.1"), "login", { limit: 2, window: "1m" })
    await expect(requireRateLimit(requestEvent("192.0.2.1"), "login", { limit: 2, window: "1m" })).rejects.toMatchObject({ status: 429 })

    await expect(resetRateLimit("login", "192.0.2.1")).resolves.toEqual({
      key: "192.0.2.1",
      name: "login",
      provider: "memory",
      scope: "process",
      status: "reset",
    })
    await expect(peekRateLimit("login", "192.0.2.1")).resolves.toMatchObject({ counters: [{ used: 0 }] })
    await expect(requireRateLimit(requestEvent("192.0.2.1"), "login", { limit: 2, window: "1m" })).resolves.toBeUndefined()
  })

  it("reports one counter for each policy that uses the same ID", async () => {
    await requireRateLimit(requestEvent("192.0.2.1"), "search", { limit: 2, window: "1m" })
    await requireRateLimit(requestEvent("192.0.2.1"), "search", { limit: 10, window: "1h" })

    const result = await peekRateLimit("search", "192.0.2.1")
    expect(result).toMatchObject({ status: "known" })
    expect(result.status === "known" ? result.counters.map(counter => [counter.limit, counter.window, counter.used]) : []).toEqual([
      [2, "1m", 1],
      [10, "1h", 1],
    ])
  })

  it("reports unsupported for the Cloudflare provider", async () => {
    setRateLimitRuntimeConfig({ provider: "cloudflare" })
    const reason = "The Cloudflare Rate Limiting binding exposes only limit(), which consumes a token. It cannot read or reset a counter."

    await expect(peekRateLimit("login", "192.0.2.1")).resolves.toEqual({ key: "192.0.2.1", name: "login", provider: "cloudflare", reason, status: "unsupported" })
    await expect(resetRateLimit("login", "192.0.2.1")).resolves.toEqual({ key: "192.0.2.1", name: "login", provider: "cloudflare", reason, status: "unsupported" })
  })

  it("rejects an empty ID or key", async () => {
    await expect(peekRateLimit(" ", "192.0.2.1")).rejects.toThrow("name must be a non-empty string")
    await expect(resetRateLimit("login", "")).rejects.toThrow("key must be a non-empty string")
  })
})
