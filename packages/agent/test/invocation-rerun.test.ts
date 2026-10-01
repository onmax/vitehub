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
  attributes: { "input.replay.version": 1, "input.hasInvoker": false, "input.hasData": false, "input.hasOptions": false, "input.hasContext": false, "input.hasRun": false, "input.hasTimeout": false, "input.hasMessages": false, ...attributes },
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

  it.each(["invoker", "actor"])("rejects a direct %s even with a profile", async (key) => {
    for (const invokerProfileId of [undefined, "reviewer"]) {
      const record = await journaled({ context: { [key]: { id: "direct-user", kind: "user" }, invokerProfileId }, prompt: "Hi" })
      expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-has-invoker" })
    }
  })

  it("rejects persisted records without the replay schema", () => {
    for (const attributes of [
      { "input.prompt": "Hi", "agent.invoker.id": "reviewer" },
      { "input.prompt": "Hi", "input.hasOptions": false },
      { "input.prompt": "Hi", "input.replay.version": 1 },
    ]) {
      expect(agentInvocationRerunInput({ observations: [{ ...start({}), attributes }] }))
        .toEqual({ available: false, reason: "replay-metadata-unavailable" })
    }
  })

  it.each(["input.hasInvoker", "input.hasData", "input.hasOptions", "input.hasContext", "input.hasRun", "input.hasTimeout", "input.hasMessages"])("rejects replay metadata missing %s", (key) => {
    const observation = start({ "input.prompt": "Hi" })
    delete observation.attributes![key]
    expect(agentInvocationRerunInput({ observations: [observation] }))
      .toEqual({ available: false, reason: "replay-metadata-unavailable" })
  })

  it("retains restored invokers after the selected profile is removed", async () => {
    const input = restoreResolvedAgentInvokerInput(portableResolvedAgentInvokerInput(withResolvedAgentInvokerInput(
      { context: { invokerProfileId: "removed-profile" }, prompt: "Hi" },
      { id: "resolved-user", kind: "user" },
    )))
    const record = await journaled(input)
    expect(record.observations.find(observation => observation.name === "agent.invocation.start")?.attributes)
      .toMatchObject({ "agent.invoker.id": "resolved-user", "agent.invoker.profile.id": "removed-profile" })
    expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-has-invoker" })
  })

  it("disables rerun when a redactor rewrites the captured prompt", async () => {
    const record = await journaled({ prompt: "Original prompt" }, {
      redact: observation => observation.name === "agent.invocation.start"
        ? { ...observation, attributes: { ...observation.attributes, "input.prompt": "Redacted prompt" } }
        : observation,
    })
    expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-redacted" })
  })

  it.each(["input.replay.version", "input.hasInvoker", "agent.invoker.profile.id", "input.hasData", "input.hasOptions", "input.hasContext", "input.hasRun", "input.hasTimeout", "input.hasMessages", "input.hasPrompt"])("rejects replay when redaction changes %s", async (key) => {
    for (const replacement of [undefined, key === "agent.invoker.profile.id" ? "other-profile" : key === "input.replay.version" ? 2 : key !== "input.hasPrompt"]) {
      const record = await journaled({ context: { invokerProfileId: "reviewer" }, prompt: "Original prompt" }, {
        redact: observation => observation.name === "agent.invocation.start"
          ? { ...observation, attributes: { ...observation.attributes, [key]: replacement } }
          : observation,
      })
      expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-redacted" })
    }
  })

  it("rejects replay when redaction hides additional input", async () => {
    for (const input of [
      { data: { subject: "Release notes" }, prompt: "Summarize this." },
      { options: { temperature: 0.2 }, prompt: "Summarize this." },
      { messages: [createMessage({ role: "user", text: "Earlier turn" })], prompt: "Continue." },
    ]) {
      const record = await journaled(input, {
        redact: observation => observation.name === "agent.invocation.start"
          ? { ...observation, attributes: { ...observation.attributes, "input.hasData": false, "input.hasOptions": false, "input.hasContext": false, "input.hasRun": false, "input.hasTimeout": false, "input.hasMessages": false } }
          : observation,
      })
      expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-redacted" })
    }
  })

  it("reports input that the journal does not keep for replay", async () => {
    const withData = await journaled({ data: { subject: "Release notes" }, prompt: "Summarize this." })
    expect(withData.observations.find(observation => observation.name === "agent.invocation.start")?.attributes?.["input.hasData"]).toBe(true)
    expect(agentInvocationRerunInput(withData)).toEqual({ available: false, reason: "input-has-data" })

    const withOptions = await journaled({ options: { temperature: 0.2 }, prompt: "Use the configured model." })
    expect(withOptions.observations.find(observation => observation.name === "agent.invocation.start")?.attributes?.["input.hasOptions"]).toBe(true)
    expect(agentInvocationRerunInput(withOptions)).toEqual({ available: false, reason: "input-has-options" })

    const withContext = await journaled({ context: { trustedScope: "customer-a" }, prompt: "Use the customer scope." })
    expect(agentInvocationRerunInput(withContext)).toEqual({ available: false, reason: "input-has-context" })

    const withRun = await journaled({ prompt: "Use the run metadata." }, {}, undefined, "reviewer")
    withRun.observations.find(observation => observation.name === "agent.invocation.start")!.attributes!["input.hasRun"] = true
    expect(agentInvocationRerunInput(withRun)).toEqual({ available: false, reason: "input-has-run" })

    const withTimeout = await journaled({ prompt: "Respect the deadline.", timeout: 1000 })
    expect(agentInvocationRerunInput(withTimeout)).toEqual({ available: false, reason: "input-has-timeout" })

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
