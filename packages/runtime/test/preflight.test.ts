import { describe, expect, it, vi } from "vitest"

import { runRuntimePreflight, startRuntimePreflight } from "../src/index.ts"

describe("runtime preflight", () => {
  it("returns a compact manifest and structured diagnostics", async () => {
    const report = vi.fn()
    const manifest = await runRuntimePreflight({
      checks: [
        { id: "command:git", kind: "command", required: true, check: () => ({ state: "available", details: { path: "/usr/bin/git" } }) },
        { id: "file:AGENTS.md", kind: "file", check: () => false },
        { id: "mcp:productlane", kind: "mcp", check: () => ({ state: "unknown", reason: "schema unavailable" }) },
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
    expect(report).toHaveBeenCalledTimes(2)
    expect(report.mock.calls[0]![0].diagnostic.code).toBe("RUNTIME_PREFLIGHT_MISSING")
  })

  it("bounds slow checks and keeps the reporter off the critical path", async () => {
    let release: (() => void) | undefined
    const report = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const started = Date.now()
    const manifest = await runRuntimePreflight({
      timeoutMs: 10,
      checks: [{ id: "browser:agent-browser", kind: "browser", check: () => new Promise(() => {}) }],
      onDiagnostic: report,
    })

    expect(manifest.checks[0]).toMatchObject({ state: "unknown", reason: "Runtime preflight check timed out." })
    expect(Date.now() - started).toBeLessThan(250)
    expect(report).toHaveBeenCalledTimes(1)
    release?.()
  })

  it("cancels checks that do not observe the signal", async () => {
    const handle = startRuntimePreflight({
      timeoutMs: 5_000,
      checks: [{ id: "command:slow", kind: "command", check: () => new Promise(() => {}) }],
    })
    handle.cancel()
    await expect(handle.manifest).resolves.toMatchObject({
      capabilities: { "command:slow": "unknown" },
      checks: [{ reason: "Runtime preflight cancelled." }],
    })
  })

  it("validates check identity and bounded options", async () => {
    await expect(runRuntimePreflight({ checks: [{ id: "same", kind: "tool", check: () => true }, { id: "same", kind: "tool", check: () => true }] })).rejects.toThrow("duplicated")
    await expect(runRuntimePreflight({ timeoutMs: 0, checks: [] })).rejects.toThrow("timeoutMs")
    await expect(runRuntimePreflight({ maxChecks: 129, checks: [] })).rejects.toThrow("maxChecks")
  })
})

