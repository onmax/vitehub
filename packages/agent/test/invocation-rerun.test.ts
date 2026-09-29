import { createMessage } from "../src/messages.ts"
import { describe, expect, it, vi } from "vitest"

import { agentInvocationRerunInput, defineAgent, runAgent } from "../src/index.ts"
import { AGENT_INVOCATION_OBSERVATION_TRUNCATED_ATTRIBUTE, createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"

import type { AgentInvocationsOptions } from "../src/server.ts"
import type { TraceEventLogEntry } from "@vite-hub/runtime"

function runtime(runId: string) {
  return {
    memo: vi.fn(),
    run: { runId },
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    runtime: "unknown" as const,
    waitUntil: vi.fn(),
  }
}

async function journaled(input: Parameters<typeof runAgent>[2], options: Partial<AgentInvocationsOptions> = {}) {
  const invocations = defineAgentInvocations({ metadataContent: ["input.messages", "input.prompt"], ...options, store: createMemoryAgentInvocationStore() })
  const agent = defineAgent({
    driver: { run: async () => "done" },
    invocations,
    invoker: { profiles: [{ id: "reviewer", kind: "user", label: "Reviewer" }] },
    runtime: false,
  })
  const runId = `rerun-${Math.random().toString(36).slice(2)}`
  await runAgent(agent, runtime(runId), input)
  await vi.waitFor(async () => {
    expect(await invocations.getByRunId(runId)).toMatchObject({ status: "completed" })
  })
  return (await invocations.getByRunId(runId))!
}

const start = (attributes: Record<string, unknown>): TraceEventLogEntry => ({
  attributes,
  name: "agent.invocation.start",
  sequence: 1,
  timestamp: new Date(0).toISOString(),
  type: "run",
})

describe("agentInvocationRerunInput", () => {
  it("returns the captured prompt and selected Invoker Profile", async () => {
    const record = await journaled({ context: { invokerProfileId: "reviewer" }, prompt: "Summarize the release notes." })
    expect(agentInvocationRerunInput(record)).toEqual({ available: true, invokerId: "reviewer", prompt: "Summarize the release notes." })
  })

  it("reports input that the journal does not keep for replay", async () => {
    const withMessages = await journaled({ messages: [createMessage({ role: "user", text: "Earlier turn" })], prompt: "Continue." })
    expect(agentInvocationRerunInput(withMessages)).toEqual({ available: false, reason: "input-has-messages" })

    const metadataOnly = await journaled({ prompt: "Private prompt." }, { metadataContent: [] })
    expect(agentInvocationRerunInput(metadataOnly)).toEqual({ available: false, reason: "input-not-captured" })

    const bounded = await journaled({ prompt: "x".repeat(2_000) }, { observations: { maxStringLength: 1_000 } })
    expect(agentInvocationRerunInput(bounded)).toEqual({ available: false, reason: "input-truncated" })
  })

  it("requires a complete start observation with a text prompt", () => {
    expect(agentInvocationRerunInput({ observations: [] })).toEqual({ available: false, reason: "input-not-captured" })
    expect(agentInvocationRerunInput({ observations: [start({ "input.prompt": "  " })] })).toEqual({ available: false, reason: "input-not-captured" })
    expect(agentInvocationRerunInput({ observations: [start({ "input.prompt": "Hi", [AGENT_INVOCATION_OBSERVATION_TRUNCATED_ATTRIBUTE]: true })] }))
      .toEqual({ available: false, reason: "input-truncated" })
    expect(agentInvocationRerunInput({ observations: [start({ "input.prompt": "Hi" })] })).toEqual({ available: true, prompt: "Hi" })
  })
})
