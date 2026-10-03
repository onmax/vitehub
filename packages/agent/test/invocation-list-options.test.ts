import { describe, expect, it } from "vitest"

import { normalizeAgentInvocationListOptions } from "../src/invocations/list-options.ts"

import type { AgentInvocationListOptions } from "../src/invocations.ts"

describe("Agent Invocation list normalization", () => {
  it("bounds a page and normalizes shared filters without consuming opaque cursors", () => {
    expect(normalizeAgentInvocationListOptions({
      agentName: "  writer  ",
      capabilityId: "  files  ",
      cursor: "provider/token",
      limit: 1_000,
      search: "  ViteHub  ",
      status: [],
      triggeredBy: "  scheduler  ",
    })).toEqual({
      agentName: "writer",
      capabilityId: "files",
      cursor: "provider/token",
      limit: 100,
      search: "ViteHub",
      status: [],
      triggeredBy: "scheduler",
    })
  })

  it("omits blank optional filters without mutating caller options", () => {
    const options = { agentName: " ", capabilityId: " ", search: " ", triggeredBy: " " }
    expect(normalizeAgentInvocationListOptions(options)).toEqual({ limit: 50 })
    expect(options).toEqual({ agentName: " ", capabilityId: " ", search: " ", triggeredBy: " " })
  })

  it.each(["provider/token", "01", "1.0", " 1", "0", String(Number.MAX_SAFE_INTEGER + 1)])(
    "rejects %s only when the store uses sequence cursors",
    cursor => {
      expect(() => normalizeAgentInvocationListOptions({ cursor }, { sequenceCursor: true }))
        .toThrow("cursor is invalid")
      expect(normalizeAgentInvocationListOptions({ cursor }).cursor).toBe(cursor)
    },
  )

  it("keeps limit and search validation independent of the selected store", () => {
    expect(() => normalizeAgentInvocationListOptions({ limit: 0 })).toThrow("positive integer")
    expect(() => normalizeAgentInvocationListOptions({ search: "x".repeat(257) })).toThrow("at most 256")
    // SAFETY: Deliberately violates the typed input to check provider-facing runtime validation.
    expect(() => normalizeAgentInvocationListOptions({ search: 1 } as unknown as AgentInvocationListOptions))
      .toThrow("search must be a string")
  })
})
