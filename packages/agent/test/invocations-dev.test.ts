import { afterEach, describe, expect, it, vi } from "vitest"

const modelGenerate = vi.hoisted(() => vi.fn())
const registry = vi.hoisted((): Record<string, () => Promise<unknown>> => ({}))

vi.mock("#vitehub/agent/registry", () => ({ default: registry }))
vi.mock("../src/internal/ai-sdk-runtime.ts", () => ({
  loadAiSdk: async () => ({
    ToolLoopAgent: class {
      async generate(...args: unknown[]) {
        return await modelGenerate(...args)
      }
    },
    isStepCount: () => () => false,
    jsonSchema: (schema: unknown) => schema,
  }),
}))

import { agentInvocationId, defineAgent, runAgent } from "../src/index.ts"
import { agentInvocationsDevHeader, agentInvocationsDevRuntimeRoute } from "../src/invocations-dev.ts"
import { handleAgentInvocationsDevRequest } from "../src/runtime/invocations-dev.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"

import type { AgentInvocations } from "../src/index.ts"

const runtime = (runId: string) => ({ memo: vi.fn(), run: { runId }, runtime: "unknown" as const, waitUntil: vi.fn() })
// SAFETY: The mocked AI SDK never reads the model; the hoisted generate mock handles execution.
const modelDriver = { execution: { workspaceFallback: false }, model: {} as never }

function devRequest(body: unknown, headers: Record<string, string> = { [agentInvocationsDevHeader]: "1" }): Request {
  return new Request(`http://localhost${agentInvocationsDevRuntimeRoute}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  })
}

async function runningId(invocations: AgentInvocations, runId: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const record = await invocations.getByRunId(runId, "digest")
    if (record?.status === "running") return record.id
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Invocation ${runId} did not start.`)
}

afterEach(() => {
  modelGenerate.mockReset()
  for (const name of Object.keys(registry)) Reflect.deleteProperty(registry, name)
})

describe("Agent Invocations Nitro dev handler", () => {
  it("does not cancel a match when another journal lookup fails", async () => {
    const store = createMemoryAgentInvocationStore()
    const timestamp = new Date().toISOString()
    await store.create({ createdAt: timestamp, id: "healthy-id", observations: [], status: "completed", traceId: "healthy", updatedAt: timestamp })
    const healthy = defineAgentInvocations({ store })
    const owning = { ...healthy, cancel: vi.fn(async (id: string) => ({ id, outcome: "terminal" as const, status: "completed" as const })) }
    const failing = { ...healthy, getSummary: vi.fn(async () => { throw new Error("Unavailable journal") }) }
    registry.first = async () => ({ default: defineAgent({ invocations: failing, driver: { run: () => "done" } }) })
    registry.second = async () => ({ default: defineAgent({ invocations: owning, driver: { run: () => "done" } }) })
    const response = await handleAgentInvocationsDevRequest(devRequest({ id: "healthy-id", operation: "cancel" }))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("Unavailable journal") } })
    expect(owning.cancel).not.toHaveBeenCalled()
    expect((await healthy.getSummary("healthy-id"))?.cancelRequestedAt).toBeUndefined()
  })

  it.each(["first", "second"] as const)("does not cancel when the %s journal cannot be read to establish uniqueness", async unreadablePosition => {
    const firstStore = createMemoryAgentInvocationStore()
    const secondStore = createMemoryAgentInvocationStore()
    const first = defineAgentInvocations({ store: firstStore })
    const second = defineAgentInvocations({ store: secondStore })
    const unreadable = { ...second, getSummary: vi.fn(async () => { throw new Error("Unavailable journal") }) }
    const id = await agentInvocationId("unreadable-duplicate-journals", "digest")
    const timestamp = new Date().toISOString()
    await firstStore.create({ createdAt: timestamp, id, observations: [], status: "running", traceId: "first", updatedAt: timestamp })
    await secondStore.create({ createdAt: timestamp, id, observations: [], status: "running", traceId: "second", updatedAt: timestamp })
    registry.first = async () => ({ default: defineAgent({ invocations: unreadablePosition === "first" ? unreadable : first, driver: { run: () => "done" } }) })
    registry.second = async () => ({ default: defineAgent({ invocations: unreadablePosition === "first" ? first : unreadable, driver: { run: () => "done" } }) })
    const response = await handleAgentInvocationsDevRequest(devRequest({ id, operation: "cancel" }))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("Unavailable journal") } })
    expect((await first.getSummary(id))?.cancelRequestedAt).toBeUndefined()
    expect((await second.getSummary(id))?.cancelRequestedAt).toBeUndefined()
  })

  it.each([["completed", "running"], ["running", "completed"], ["running", "running"]] as const)("rejects duplicate IDs across %s and %s journals before changing either", async (firstStatus, secondStatus) => {
    const firstStore = createMemoryAgentInvocationStore()
    const secondStore = createMemoryAgentInvocationStore()
    const first = defineAgentInvocations({ store: firstStore })
    const second = defineAgentInvocations({ store: secondStore })
    const id = await agentInvocationId("duplicate-journals", "digest")
    const timestamp = new Date().toISOString()
    await firstStore.create({ createdAt: timestamp, id, observations: [], status: firstStatus, traceId: "first", updatedAt: timestamp })
    await secondStore.create({ createdAt: timestamp, id, observations: [], status: secondStatus, traceId: "second", updatedAt: timestamp })
    registry.first = async () => ({ default: defineAgent({ invocations: first, driver: { run: () => "done" } }) })
    registry.second = async () => ({ default: defineAgent({ invocations: second, driver: { run: () => "done" } }) })
    const response = await handleAgentInvocationsDevRequest(devRequest({ id, operation: "cancel" }))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("multiple Agent invocation journals") } })
    expect((await first.getSummary(id))?.cancelRequestedAt).toBeUndefined()
    expect((await second.getSummary(id))?.cancelRequestedAt).toBeUndefined()
  })

  it("deduplicates one journal shared by registry entries", async () => {
    const store = createMemoryAgentInvocationStore()
    const timestamp = new Date().toISOString()
    const id = await agentInvocationId("shared-journal", "digest")
    await store.create({ createdAt: timestamp, id, observations: [], status: "running", traceId: "shared", updatedAt: timestamp })
    const invocations = defineAgentInvocations({ store })
    registry.first = async () => ({ default: defineAgent({ invocations, driver: { run: () => "done" } }) })
    registry.second = async () => ({ default: defineAgent({ invocations, driver: { run: () => "done" } }) })
    const response = await handleAgentInvocationsDevRequest(devRequest({ id, operation: "cancel" }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id, outcome: "requested" })
    expect((await invocations.getSummary(id))?.cancelRequestedAt).toEqual(expect.any(String))
  })

  it("cancels a running Invocation through the application registry", async () => {
    modelGenerate.mockImplementation(async (input: { abortSignal?: AbortSignal }) => await new Promise((_resolve, reject) => {
      const signal = input.abortSignal
      if (signal?.aborted) reject(signal.reason)
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
    }))
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({ driver: modelDriver, invocations, name: "digest" })
    registry.digest = async () => ({ default: agent })
    registry.broken = async () => { throw new Error("Definition failed to load.") }
    const run = runAgent(agent, runtime("dev-cancel"), { prompt: "Summarize the release." })
    const id = await runningId(invocations, "dev-cancel")

    const response = await handleAgentInvocationsDevRequest(devRequest({ id, operation: "cancel" }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ delivery: "local", id, outcome: "requested", status: "running" })
    await expect(run).rejects.toThrow(`Cancellation was requested for Agent Invocation "${id}"`)
    expect((await invocations.get(id))?.status).toBe("cancelled")

    const missing = await handleAgentInvocationsDevRequest(devRequest({ id: "ainv_missing", operation: "cancel" }))
    expect(await missing.json()).toEqual({ id: "ainv_missing", outcome: "not-found" })
  })

  it("rejects requests without the guard, with an invalid body, or without a journal", async () => {
    expect((await handleAgentInvocationsDevRequest(devRequest({ id: "ainv_1", operation: "cancel" }, {}))).status).toBe(403)
    expect((await handleAgentInvocationsDevRequest(devRequest({ id: "ainv_1", operation: "cancel" }, {
      [agentInvocationsDevHeader]: "1",
      origin: "https://attacker.example",
    }))).status).toBe(403)
    expect((await handleAgentInvocationsDevRequest(devRequest({ operation: "cancel" }))).status).toBe(400)

    registry.plain = async () => ({ default: defineAgent({ driver: modelDriver, name: "plain" }) })
    const response = await handleAgentInvocationsDevRequest(devRequest({ id: "ainv_1", operation: "cancel" }))
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { message: "No Agent invocation journal is configured." } })
  })
})
