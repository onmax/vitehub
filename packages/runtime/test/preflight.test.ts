import { describe, expect, it, vi } from "vitest"

import { runRuntimePreflight, startRuntimePreflight } from "../src/index.ts"

describe("runtime preflight", () => {
  it("returns a compact manifest and structured diagnostics", async () => {
    const report = vi.fn()
    const manifest = await runRuntimePreflight({
      checks: [
        { id: "command:git", kind: "command", required: true, check: async () => ({ state: "available", details: { path: "/usr/bin/git" } }) },
        { id: "file:AGENTS.md", kind: "file", check: async () => false },
        { id: "mcp:productlane", kind: "mcp", check: async () => ({ state: "unknown", reason: "schema unavailable" }) },
      ],
      onDiagnostic: report,
    })

    expect(manifest.version).toBe(1)
    expect(manifest.capabilities).toEqual({ "command:git": "available", "file:AGENTS.md": "missing", "mcp:productlane": "unknown" })
    expect(manifest.checks[0]).toMatchObject({ id: "command:git", state: "available", details: { path: "/usr/bin/git" } })
    expect(manifest.diagnostics).toHaveLength(2)
    expect(manifest.diagnostics[0]).toMatchObject({
      name: "RUNTIME_PREFLIGHT_MISSING",
      data: { checkId: "file:AGENTS.md", kind: "file", required: false, state: "missing" },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(report).toHaveBeenCalledTimes(2)
    expect(report.mock.calls[0]![0].diagnostic.code).toBe("RUNTIME_PREFLIGHT_MISSING")
  })

  it("bounds slow checks and keeps the reporter off the critical path", async () => {
    let release: (() => void) | undefined
    const report = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const started = Date.now()
    const manifest = await runRuntimePreflight({
      timeoutMs: 10,
      checks: [{ id: "browser:agent-browser", kind: "browser", check: async () => await new Promise(() => {}) }],
      onDiagnostic: report,
    })

    expect(manifest.checks[0]).toMatchObject({ state: "unknown", reason: "Runtime preflight check timed out." })
    expect(Date.now() - started).toBeLessThan(250)
    expect(report).not.toHaveBeenCalled()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(report).toHaveBeenCalledTimes(1)
    release?.()
  })

  it("cancels checks that do not observe the signal", async () => {
    let started = false
    const handle = startRuntimePreflight({
      timeoutMs: 5_000,
      checks: [{ id: "command:slow", kind: "command", check: async () => { started = true; return await new Promise(() => {}) } }],
    })
    handle.cancel()
    await expect(handle.manifest).resolves.toMatchObject({
      capabilities: { "command:slow": "unknown" },
      checks: [{ reason: "Runtime preflight cancelled." }],
    })
    expect(started).toBe(false)
  })

  it("isolates reporter errors", async () => {
    const report = vi.fn(() => { throw new Error("reporter failed") })
    const manifest = await runRuntimePreflight({
      timeoutMs: 1,
      checks: [{
        id: "command:stuck",
        kind: "command",
        check: async () => await new Promise(() => {}),
      }],
      onDiagnostic: report,
    })
    expect(manifest.checks[0]).toMatchObject({ state: "unknown", reason: "Runtime preflight check timed out." })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(report).toHaveBeenCalledTimes(1)
  })

  it("rejects synchronous checks before invoking them", () => {
    let invoked = false
    expect(() => startRuntimePreflight({
      checks: [{ id: "command:blocking", kind: "command", check: (() => { invoked = true; return true }) as never }],
    })).toThrow("check function")
    expect(invoked).toBe(false)
  })

  it("does not treat callable result records as available", async () => {
    const result = Object.assign(() => true, { state: "available" })
    const manifest = await runRuntimePreflight({
      checks: [{ id: "tool:malformed", kind: "tool", check: async () => result as never }],
    })
    expect(manifest.capabilities["tool:malformed"]).toBe("unknown")
  })

  it("defers early failure reporters until the slow check settles", async () => {
    const report = vi.fn()
    const manifest = await runRuntimePreflight({
      timeoutMs: 20,
      checks: [
        { id: "early", kind: "tool", check: async () => false },
        { id: "slow", kind: "tool", check: async () => await new Promise(() => {}) },
      ],
      onDiagnostic: report,
    })
    expect(manifest.checks).toHaveLength(2)
    expect(report).not.toHaveBeenCalled()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(report).toHaveBeenCalledTimes(2)
  })

  it("does not read accessors or properties beyond the detail cap", async () => {
    const getter = vi.fn(() => { throw new Error("must not be read") })
    const details = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`key${i}`, i]))
    Object.defineProperty(details, "extra", { enumerable: true, get: getter })
    const manifest = await runRuntimePreflight({
      checks: [{ id: "details", kind: "tool", check: async () => ({ state: "available", details }) }],
    })
    expect(Object.keys(manifest.checks[0]!.details!)).toHaveLength(12)
    expect(getter).not.toHaveBeenCalled()
    const accessorDetails = Object.defineProperty({}, "value", { enumerable: true, get: getter })
    await runRuntimePreflight({
      checks: [{ id: "accessor", kind: "tool", check: async () => ({ state: "available", details: accessorDetails }) }],
    })
    expect(getter).not.toHaveBeenCalled()
  })

  it("validates check identity and bounded options", async () => {
    await expect(runRuntimePreflight({ checks: [{ id: "same", kind: "tool", check: async () => true }, { id: "same", kind: "tool", check: async () => true }] })).rejects.toThrow("duplicated")
    await expect(runRuntimePreflight({ timeoutMs: 0, checks: [] })).rejects.toThrow("timeoutMs")
    await expect(runRuntimePreflight({ maxChecks: 129, checks: [] })).rejects.toThrow("maxChecks")
    await expect(runRuntimePreflight({ maxChecks: 1, checks: [{ id: "one", kind: "tool", check: async () => true }, { id: "two", kind: "tool", check: async () => true }] })).rejects.toThrow("exceed")
  })
})
