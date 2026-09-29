import { afterEach, describe, expect, it, vi } from "vitest"

const modelGenerate = vi.hoisted(() => vi.fn())

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

import { agentInvocationId, defineAgent, runAgent, startAgentInvocation } from "../src/index.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"

import type { AgentInvocationRecordStatus, AgentInvocations } from "../src/index.ts"

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) return
    if (signal.aborted) reject(signal.reason)
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}

const runtime = (runId: string) => ({ memo: vi.fn(), run: { runId }, runtime: "unknown" as const, waitUntil: vi.fn() })
// SAFETY: The mocked AI SDK never reads the model; the hoisted generate mock handles execution.
const modelDriver = { execution: { workspaceFallback: false }, model: {} as never }

async function recordWithStatus(invocations: AgentInvocations, runId: string, status: AgentInvocationRecordStatus, agentName?: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const record = await invocations.getByRunId(runId, agentName)
    if (record?.status === status) return record
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Invocation ${runId} did not reach ${status}.`)
}

afterEach(() => {
  modelGenerate.mockReset()
  vi.useRealTimers()
})

describe("Agent Invocation cancel", () => {
  it("aborts a running model Driver in this process", async () => {
    modelGenerate.mockImplementation(async (input: { abortSignal?: AbortSignal }) => await untilAborted(input.abortSignal))
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const run = runAgent(defineAgent({ driver: modelDriver, invocations }), runtime("model-cancel"), { prompt: "Summarize the release." })
    const { id } = await recordWithStatus(invocations, "model-cancel", "running")

    expect(await invocations.cancel(id)).toEqual({ delivery: "local", id, outcome: "requested", status: "running" })
    await expect(run).rejects.toThrow(`Cancellation was requested for Agent Invocation "${id}"`)

    const record = await invocations.get(id)
    expect(record).toMatchObject({ cancelRequestedAt: expect.any(String), cancelledAt: expect.any(String), status: "cancelled" })
    expect(record?.cancelNotEnforcedBy).toBeUndefined()
    expect(record?.observations.map(entry => entry.name)).toContain("agent.invocation.cancelled")
    expect(await invocations.cancel(id)).toEqual({ id, outcome: "terminal", status: "cancelled" })
  })

  it("reports that a custom run Driver does not enforce cancel", async () => {
    const release = deferred<string>()
    const started = deferred()
    let signal: AbortSignal | undefined
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const run = runAgent(defineAgent({
      driver: { run: (context) => {
        signal = context.input.abortSignal
        started.resolve()
        return release.promise
      } },
      invocations,
    }), runtime("run-cancel"), { prompt: "Compile the digest." })
    await started.promise
    const { cancelNotEnforcedBy, id } = await recordWithStatus(invocations, "run-cancel", "running")
    expect(cancelNotEnforcedBy).toBe("run")

    expect(await invocations.cancel(id)).toEqual({ delivery: "local", id, notEnforcedBy: "run", outcome: "requested", status: "running" })
    // The handler receives the aborted signal, but ViteHub does not stop it.
    expect(signal?.aborted).toBe(true)
    expect((await invocations.get(id))?.status).toBe("running")

    release.resolve("Done.")
    // The handler did not stop, so its result completes the Invocation.
    await expect(run).resolves.toBe("Done.")
    expect((await invocations.get(id))?.status).toBe("completed")
  })

  it("completes a started custom run Invocation when its handler ignores cancel", async () => {
    const release = deferred<string>()
    const started = deferred()
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: { run: () => {
        started.resolve()
        return release.promise
      } },
      invocations,
      name: "digest",
    })
    const controller = await startAgentInvocation(agent, { ...runtime("started-run-cancel"), agentIdentity: { name: "digest" } }, { prompt: "Compile the digest." })
    await started.promise
    const id = await agentInvocationId(controller.id, "digest")
    await recordWithStatus(invocations, controller.id, "running", "digest")

    expect(await invocations.cancel(id)).toMatchObject({ delivery: "local", notEnforcedBy: "run", outcome: "requested" })
    release.resolve("Done.")
    await vi.waitFor(async () => expect((await invocations.get(id))?.status).toBe("completed"), { timeout: 5_000 })
  })

  it("cancels an Invocation that waits for Driver capacity", async () => {
    const first = deferred<string>()
    const firstStarted = deferred()
    const second = vi.fn(() => "Second.")
    let calls = 0
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: {
        capacity: { concurrency: 1, queue: { maxPending: 1 } },
        run: () => {
          calls++
          if (calls > 1) return second()
          firstStarted.resolve()
          return first.promise
        },
      },
      invocations,
    })
    const running = runAgent(agent, runtime("capacity-first"), { prompt: "First" })
    await firstStarted.promise
    const queued = runAgent(agent, runtime("capacity-second"), { prompt: "Second" })
    const { id } = await recordWithStatus(invocations, "capacity-second", "pending")

    expect(await invocations.cancel(id)).toMatchObject({ delivery: "local", id, outcome: "requested", status: "pending" })
    await expect(queued).rejects.toThrow("Cancellation was requested")
    expect((await invocations.get(id))?.status).toBe("cancelled")

    first.resolve("First.")
    await running
    expect(second).not.toHaveBeenCalled()
  })

  it("picks up a cancel request from another instance at the claim heartbeat", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    modelGenerate.mockImplementation(async (input: { abortSignal?: AbortSignal }) => await untilAborted(input.abortSignal))
    const store = createMemoryAgentInvocationStore()
    const owner = defineAgentInvocations({ store })
    const run = runAgent(defineAgent({ driver: modelDriver, invocations: owner }), runtime("remote-cancel"), { prompt: "Wait." })
    const { id } = await recordWithStatus(owner, "remote-cancel", "running")

    // Another instance shares only the store. It writes the same flag that its cancel() writes.
    await store.update(id, { cancelRequestedAt: new Date().toISOString(), timestamp: new Date().toISOString() })
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(run).rejects.toThrow("Cancellation was requested")
    expect((await owner.get(id))?.status).toBe("cancelled")
  })

  it("delivers a cancel request through the journal when another instance holds the claim", async () => {
    const store = createMemoryAgentInvocationStore()
    const invocations = defineAgentInvocations({ store })
    const id = await agentInvocationId("remote-owner")
    const timestamp = new Date().toISOString()
    await store.create({ cancelNotEnforcedBy: "run", createdAt: timestamp, id, observations: [], status: "running", traceId: "trace-remote", updatedAt: timestamp })
    expect(await store.claim(id, "remote-claim", 30_000)).toBe(true)

    expect(await invocations.cancel(id)).toEqual({ delivery: "journal", id, notEnforcedBy: "run", outcome: "requested", status: "running" })
    expect((await invocations.getSummary(id))?.cancelRequestedAt).toEqual(expect.any(String))
  })

  it("cancels a queued Invocation that no run holds, and a later run stops before the Driver starts", async () => {
    const store = createMemoryAgentInvocationStore()
    const invocations = defineAgentInvocations({ store })
    const id = await agentInvocationId("queued-cancel")
    const timestamp = new Date().toISOString()
    await store.create({ createdAt: timestamp, id, observations: [], status: "pending", traceId: "trace-queued", updatedAt: timestamp })

    expect(await invocations.cancel(id)).toEqual({ id, outcome: "cancelled", status: "cancelled" })
    const record = await invocations.get(id)
    expect(record?.status).toBe("cancelled")
    expect(record?.observations.map(entry => entry.name)).toEqual(["agent.invocation.cancelled"])

    const driver = vi.fn(() => "Done.")
    await expect(runAgent(defineAgent({ driver: { run: driver }, invocations }), runtime("queued-cancel"), { prompt: "Late worker" })).rejects.toThrow()
    expect(driver).not.toHaveBeenCalled()
  })

  it("reports missing Invocations", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    expect(await invocations.cancel("missing")).toEqual({ id: "missing", outcome: "not-found" })
  })
})
