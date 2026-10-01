import { createMessage } from "../src/messages.ts"
import { describe, expect, it, vi } from "vitest"
import * as v from "valibot"
import { portableResolvedAgentInvokerInput, restoreResolvedAgentInvokerInput, withResolvedAgentInvokerInput } from "../src/invoker.ts"

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

async function journaled(input: Parameters<typeof runAgent>[2], options: Partial<AgentInvocationsOptions> = {}, resolve?: () => { id: string, kind: "user", label: string }, profileId = "reviewer") {
  const invocations = defineAgentInvocations({ metadataContent: ["input.messages", "input.prompt"], ...options, store: createMemoryAgentInvocationStore() })
  const agent = defineAgent({
    data: v.unknown(),
    driver: { run: async () => "done" },
    invocations,
    invoker: { profiles: [{ id: profileId, kind: "user", label: "Reviewer" }], resolve },
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
    expect(agentInvocationRerunInput(record)).toEqual({ available: true, invokerProfileId: "reviewer", prompt: "Summarize the release notes." })
  })

  it("keeps prompt replay available when unrelated metadata is bounded", async () => {
    const record = await journaled({ prompt: "Complete prompt." }, {}, () => ({ id: "resolved", kind: "user", label: "x".repeat(2_000) }))
    expect(agentInvocationRerunInput(record)).toEqual({ available: true, prompt: "Complete prompt." })
  })

  it("rejects replay when bounding changes the selected profile ID", async () => {
    const profileId = "reviewer".repeat(200)
    const record = await journaled({ context: { invokerProfileId: profileId }, prompt: "Hi" }, { observations: { maxStringLength: 1_000 } }, undefined, profileId)
    expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-truncated" })
  })

  it("preserves a selected profile when its resolver changes invoker identity", async () => {
    const record = await journaled({ context: { invokerProfileId: "reviewer" }, prompt: "Hi" }, {}, () => ({ id: "resolved", kind: "user", label: "Resolved" }))
    expect(agentInvocationRerunInput(record)).toEqual({ available: true, invokerProfileId: "reviewer", prompt: "Hi" })
  })

  it("does not trust an injected profile observation context", async () => {
    const record = await journaled({ context: { "agent.invoker.profile.id": "reviewer" }, prompt: "Hi" })
    expect(agentInvocationRerunInput(record)).toEqual({ available: true, prompt: "Hi" })
  })

  it("does not treat resolved invoker identities as profile selectors", () => {
    expect(agentInvocationRerunInput({ observations: [start({ "input.prompt": "Hi", "agent.invoker.id": "reviewer" })] }))
      .toEqual({ available: true, prompt: "Hi" })
    expect(agentInvocationRerunInput({ observations: [start({ "input.prompt": "Hi", "agent.invoker.id": "resolved", "agent.invoker.profile.id": "reviewer" })] }))
      .toEqual({ available: true, invokerProfileId: "reviewer", prompt: "Hi" })
  })

  it("retains restored invokers after the selected profile is removed", async () => {
    const input = restoreResolvedAgentInvokerInput(portableResolvedAgentInvokerInput(withResolvedAgentInvokerInput(
      { context: { invokerProfileId: "removed-profile" }, prompt: "Hi" },
      { id: "resolved-user", kind: "user" },
    )))
    const record = await journaled(input)
    expect(record.observations.find(observation => observation.name === "agent.invocation.start")?.attributes)
      .toMatchObject({ "agent.invoker.id": "resolved-user", "agent.invoker.profile.id": "removed-profile" })
  })

  it("disables rerun when a redactor rewrites the captured prompt", async () => {
    const record = await journaled({ prompt: "Original prompt" }, {
      redact: observation => observation.name === "agent.invocation.start"
        ? { ...observation, attributes: { ...observation.attributes, "input.prompt": "Redacted prompt" } }
        : observation,
    })
    expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-redacted" })
  })

  it("reports input that the journal does not keep for replay", async () => {
    const withData = await journaled({ data: { subject: "Release notes" }, prompt: "Summarize this." })
    expect(withData.observations.find(observation => observation.name === "agent.invocation.start")?.attributes?.["input.hasData"]).toBe(true)
    expect(agentInvocationRerunInput(withData)).toEqual({ available: false, reason: "input-has-data" })

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
