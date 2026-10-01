import { runInNewContext } from "node:vm"
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

import { agentInvocationId, defineAgent, defineCapability, runAgent, streamAgent, startAgentInvocation } from "../src/index.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"
import { bindAgentInvocations } from "../src/invocations.ts"
import { abortLocalAgentInvocation, isAgentInvocationAbortError } from "../src/internal/invocation-cancellation.ts"

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
  it("recognizes genuine abort errors when the native Error brand check is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(Error, "isError")
    Object.defineProperty(Error, "isError", { configurable: true, value: undefined })
    try {
      expect(isAgentInvocationAbortError(Object.assign(new Error("Aborted"), { name: "AbortError" }))).toBe(true)
      expect(isAgentInvocationAbortError(runInNewContext("Object.assign(new Error('Aborted'), { name: 'AbortError' })"))).toBe(true)
      expect(isAgentInvocationAbortError(new DOMException("Aborted", "AbortError"))).toBe(true)
      expect(isAgentInvocationAbortError({ name: "AbortError" })).toBe(false)
      expect(isAgentInvocationAbortError({ name: "AbortError", [Symbol.toStringTag]: "Error" })).toBe(false)
      expect(isAgentInvocationAbortError({ name: "AbortError", [Symbol.toStringTag]: "DOMException" })).toBe(false)
    }
    finally {
      if (original) Object.defineProperty(Error, "isError", original)
      else Reflect.deleteProperty(Error, "isError")
    }
  })

  it.each([
    { driver: { enforced: true, name: "model" }, expected: undefined },
    { driver: { enforced: true, name: "codex" }, expected: undefined },
    { driver: { enforced: false, name: "run" }, expected: "run" },
  ])("refreshes recovered cancellation metadata for the $driver.name Driver", async ({ driver, expected }) => {
    const runId = `recovered-${driver.name}`
    const id = await agentInvocationId(runId)
    const store = createMemoryAgentInvocationStore()
    const timestamp = new Date().toISOString()
    await store.create({ cancelNotEnforcedBy: "old-run", createdAt: timestamp, id, observations: [], status: "running", traceId: "recovered-trace", updatedAt: timestamp })
    const invocations = defineAgentInvocations({ store })
    // A separate store facade shares durable records without sharing process-local abort handles.
    const remoteInvocations = defineAgentInvocations({ store: { ...store } })
    const journal = await bindAgentInvocations(invocations, runtime(runId))
    if (!journal) throw new Error("Expected recovered invocation journal")
    try {
      journal.watchCancellation(driver)
      await journal.running()
      expect((await invocations.get(id))?.cancelNotEnforcedBy).toBe(expected)
      const result = await remoteInvocations.cancel(id)
      expect(result).toMatchObject({ delivery: "journal", outcome: "requested", status: "running" })
      expect(result.notEnforcedBy).toBe(expected)
    }
    finally {
      await journal.finish("cancelled")
    }
  })

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

  it.each(["unrelated", "reason", "wrapped reason"] as const)("classifies %s cleanup errors after a model Driver returns", async (failure) => {
    modelGenerate.mockResolvedValue({ text: "Done." })
    const entered = deferred()
    const release = deferred()
    let signal: AbortSignal | undefined
    let cleanupError: Error | undefined
    const runId = `model-cleanup-cancel-${failure}`
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const run = runAgent(defineAgent({
      driver: modelDriver,
      invocations,
      capabilities: [defineCapability({
        id: "cleanup",
        close: async () => {
          entered.resolve()
          await release.promise
          cleanupError = failure === "unrelated"
            ? new Error("Cleanup failed independently.")
            : failure === "reason"
              ? signal?.reason
              : new Error("Cleanup was aborted.", { cause: signal?.reason })
          throw cleanupError
        },
      })],
      hooks: { "agent:input": context => { signal = context.input.abortSignal } },
    }), runtime(runId), { prompt: "Summarize the release." })
    const settled = run.then(() => undefined, error => error)
    await entered.promise
    expect(modelGenerate).toHaveBeenCalledOnce()
    const { id } = await recordWithStatus(invocations, runId, "running")
    expect(await invocations.cancel(id)).toMatchObject({ delivery: "local", outcome: "requested", status: "running" })
    release.resolve()
    expect(await settled).toBe(cleanupError)

    const record = await invocations.get(id)
    expect(record?.status).toBe(failure === "unrelated" ? "failed" : "cancelled")
    expect(record?.error).toMatchObject({ message: cleanupError?.message })
    expect(record?.observations.some(entry => entry.name === "agent.invocation.cancelled")).toBe(failure !== "unrelated")
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

  it.each(["unrelated", "foreign-unrelated", "plain-abort-name", "hostile-tag", "reason", "wrapped-reason", "foreign-wrapped-reason", "abort-error", "foreign-abort-error", "aggregate-reason", "foreign-aggregate-reason", "cyclic-aggregate-reason", "aggregate-unrelated", "aggregate-abort-error", "foreign-aggregate-abort-error", "wrapped-abort-error"] as const)("classifies a cancelled custom handler's %s rejection by its actual error", async (failureKind) => {
    const release = deferred()
    const started = deferred()
    const failure = new Error("Independent handler failure")
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const runId = `custom-cancel-failure-${failureKind}`
    let signal: AbortSignal | undefined
    const run = runAgent(defineAgent({
      driver: { run: async (context) => {
        signal = context.input.abortSignal
        started.resolve()
        await release.promise
        if (failureKind === "plain-abort-name") throw { name: "AbortError", message: "Independent handler failure" }
        if (failureKind === "hostile-tag") throw Object.defineProperty(failure, Symbol.toStringTag, { get() { throw new Error("Hostile tag was read") } })
        if (failureKind === "reason") throw signal?.reason
        if (failureKind === "wrapped-reason") throw new Error("Handler stopped", { cause: signal?.reason })
        if (failureKind === "foreign-wrapped-reason") throw runInNewContext("new Error('Outer stop', { cause: new Error('Inner stop', { cause: reason }) })", { reason: signal?.reason })
        if (failureKind === "foreign-abort-error") throw runInNewContext("Object.assign(new Error('Handler stopped'), { name: 'AbortError' })")
        if (failureKind === "foreign-unrelated") throw runInNewContext("new Error('Independent handler failure')")
        if (failureKind === "aggregate-reason") throw new AggregateError([signal?.reason, failure], "Handler stopped with cleanup failure")
        if (failureKind === "foreign-aggregate-reason") throw runInNewContext("new AggregateError([reason, new Error('Cleanup failed')], 'Handler stopped')", { reason: signal?.reason })
        if (failureKind === "cyclic-aggregate-reason") {
          const aggregate = new AggregateError([signal?.reason, failure], "Handler stopped")
          Object.defineProperty(aggregate, "cause", { value: aggregate })
          throw aggregate
        }
        if (failureKind === "aggregate-unrelated") throw new AggregateError([failure, new Error("Cleanup failed")], "Independent failures")
        if (failureKind === "aggregate-abort-error") throw new AggregateError([new DOMException("Independent I/O aborted", "AbortError"), failure], "Independent failures")
        if (failureKind === "foreign-aggregate-abort-error") throw runInNewContext("new AggregateError([Object.assign(new Error('Independent I/O aborted'), { name: 'AbortError' })], 'Independent failures')")
        if (failureKind === "wrapped-abort-error") throw new Error("Independent failure", { cause: new DOMException("Independent I/O aborted", "AbortError") })
        if (failureKind === "abort-error") throw new DOMException("Handler stopped", "AbortError")
        throw failure
      } },
      invocations,
    }), runtime(runId), {})
    const rejected = expect(run).rejects.toBeDefined()
    await started.promise
    const { id } = await recordWithStatus(invocations, runId, "running")
    await invocations.cancel(id)
    expect(signal?.aborted).toBe(true)
    release.resolve()
    await rejected
    const record = await invocations.get(id)
    const cancelled = !["unrelated", "foreign-unrelated", "plain-abort-name", "hostile-tag", "aggregate-unrelated", "aggregate-abort-error", "foreign-aggregate-abort-error", "wrapped-abort-error"].includes(failureKind)
    expect(record?.status).toBe(cancelled ? "cancelled" : "failed")
    expect(record?.observations.some(entry => entry.name === "agent.invocation.cancelled")).toBe(cancelled)
    if (failureKind === "unrelated" || failureKind === "hostile-tag") expect(record?.error?.message).toBe(failure.message)
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
    const rejection = expect(run).rejects.toThrow("Cancellation was requested")
    const { id } = await recordWithStatus(owner, "remote-cancel", "running")

    // Another instance shares only the store. It writes the same flag that its cancel() writes.
    await store.update(id, { cancelRequestedAt: new Date().toISOString(), timestamp: new Date().toISOString() })
    await vi.advanceTimersByTimeAsync(10_000)

    await rejection
    expect((await owner.get(id))?.status).toBe("cancelled")
  })

  it.each(["completed", "failed", "cancelled"] as const)("keeps a stale model listening after nonterminal lease loss and replacement %s", async status => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    let signal: AbortSignal | undefined
    modelGenerate.mockImplementation(async (input: { abortSignal?: AbortSignal }) => {
      signal = input.abortSignal
      return await untilAborted(signal)
    })
    const backing = createMemoryAgentInvocationStore()
    const store = { ...backing, claim: (...args: Parameters<typeof backing.claim>) => backing.claim(args[0], args[1], 1, args[3]) }
    const owner = defineAgentInvocations({ store })
    const remote = defineAgentInvocations({ store: { ...backing } })
    const run = runAgent(defineAgent({ driver: modelDriver, invocations: owner }), runtime(`stale-remote-cancel-${status}`), { prompt: "Wait." })
    const rejection = expect(run).rejects.toThrow("Cancellation was requested")
    const { id } = await recordWithStatus(owner, `stale-remote-cancel-${status}`, "running")
    await vi.waitFor(() => expect(signal).toBeDefined())
    try {
      await new Promise(resolve => setTimeout(resolve, 5))
      expect(await backing.claim(id, "replacement", 30_000)).toBe(true)
      await vi.advanceTimersByTimeAsync(10_000)
      // Losing the lease does not prove execution stopped and must not itself report cancellation.
      expect(signal?.aborted).toBe(false)
      expect(await remote.cancel(id)).toMatchObject({ delivery: "journal", outcome: "requested", status: "running" })
      await backing.update(id, { status, timestamp: new Date().toISOString() })
      const terminalRecord = await backing.get(id)
      await backing.release(id, "replacement")
      await vi.advanceTimersByTimeAsync(10_000)
      expect(signal?.aborted).toBe(true)
      await rejection
      expect(await backing.get(id)).toEqual(terminalRecord)
    }
    finally {
      await backing.release(id, "replacement")
      abortLocalAgentInvocation(store, id, new Error("Cancellation was requested during fixture cleanup"))
      await rejection
    }
  })

  it.each([true, false])("aborts local work while propagating a failed initial journal read, enforced=%s", async enforced => {
    const failure = new Error("Synthetic initial journal read failure")
    const backing = createMemoryAgentInvocationStore()
    const getSummary = vi.fn(async (id: string) => await backing.getSummary(id))
    const store = { ...backing, getSummary }
    const invocations = defineAgentInvocations({ store })
    const release = deferred<string>()
    let signal: AbortSignal | undefined
    modelGenerate.mockImplementation(async (input: { abortSignal?: AbortSignal }) => {
      signal = input.abortSignal
      return await untilAborted(signal)
    })
    const custom = { run: async ({ input }: import("../src/types.ts").AgentRunContext) => {
      signal = input.abortSignal
      return await release.promise
    } }
    const runId = `failed-cancel-read-${enforced}`
    const run = runAgent(defineAgent({ driver: enforced ? modelDriver : custom, invocations }), runtime(runId), { prompt: "Wait." })
    const settled = enforced ? expect(run).rejects.toThrow("Cancellation was requested") : expect(run).resolves.toBe("Custom result")
    const { id } = await recordWithStatus(invocations, runId, "running")
    await vi.waitFor(() => expect(signal).toBeDefined())
    getSummary.mockRejectedValueOnce(failure)
    try {
      await expect(invocations.cancel(id)).rejects.toBe(failure)
      expect(signal?.aborted).toBe(true)
      expect((await backing.get(id))?.cancelRequestedAt).toBeUndefined()
      if (!enforced) expect((await backing.get(id))?.status).toBe("running")
      release.resolve("Custom result")
      await settled
      expect((await backing.get(id))?.status).toBe(enforced ? "cancelled" : "completed")
    }
    finally {
      abortLocalAgentInvocation(store, id, new Error("Cancellation was requested during fixture cleanup"))
      release.resolve("Custom result")
      await settled
    }
  })

  it.each([true, false])("aborts local work while propagating a failed cancel persistence write, enforced=%s", async enforced => {
    const failure = new Error("Synthetic cancel persistence failure")
    const backing = createMemoryAgentInvocationStore()
    const store = { ...backing, update: (...args: Parameters<typeof backing.update>) => {
      if (args[1].cancelRequestedAt) return Promise.reject(failure)
      return backing.update(...args)
    } }
    const invocations = defineAgentInvocations({ store })
    const release = deferred<string>()
    let signal: AbortSignal | undefined
    modelGenerate.mockImplementation(async (input: { abortSignal?: AbortSignal }) => {
      signal = input.abortSignal
      return await untilAborted(signal)
    })
    const custom = { run: async ({ input }: import("../src/types.ts").AgentRunContext) => {
      signal = input.abortSignal
      return await release.promise
    } }
    const runId = `failed-cancel-persistence-${enforced}`
    const run = runAgent(defineAgent({ driver: enforced ? modelDriver : custom, invocations }), runtime(runId), { prompt: "Wait." })
    const settled = enforced ? expect(run).rejects.toThrow("Cancellation was requested") : expect(run).resolves.toBe("Custom result")
    const { id } = await recordWithStatus(invocations, runId, "running")
    await vi.waitFor(() => expect(signal).toBeDefined())
    try {
      await expect(invocations.cancel(id)).rejects.toBe(failure)
      expect(signal?.aborted).toBe(true)
      expect((await backing.get(id))?.cancelRequestedAt).toBeUndefined()
      if (!enforced) expect((await backing.get(id))?.status).toBe("running")
      release.resolve("Custom result")
      await settled
      expect((await backing.get(id))?.status).toBe(enforced ? "cancelled" : "completed")
    }
    finally {
      abortLocalAgentInvocation(store, id, new Error("Cancellation was requested during fixture cleanup"))
      release.resolve("Custom result")
      await settled
    }
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

    expect(await invocations.cancel(id)).toMatchObject({ id, outcome: "requested", status: "pending" })
    const record = await invocations.get(id)
    expect(record?.status).toBe("pending")
    expect(record?.cancelRequestedAt).toEqual(expect.any(String))

    const driver = vi.fn(() => "Done.")
    await expect(runAgent(defineAgent({ driver: { run: driver }, invocations }), runtime("queued-cancel"), { prompt: "Late worker" })).rejects.toThrow()
    expect(driver).not.toHaveBeenCalled()
    expect((await invocations.get(id))?.status).toBe("cancelled")
  })

  it.each((["run", "stream"] as const).flatMap(kind =>
    [false, true].flatMap(capacity => (["hook", "prepare"] as const).flatMap(stage =>
      (["unrelated", "wrapped reason"] as const).map(failure => ({ capacity, failure, kind, stage })),
    )),
  ))("classifies $failure setup rejection during $stage, kind=$kind, capacity=$capacity", async ({ capacity, failure, kind, stage }) => {
    const entered = deferred()
    const release = deferred()
    const close = vi.fn()
    const driver = vi.fn(() => "Must not run")
    let setupError: Error | undefined
    const suspend = async (signal: AbortSignal | undefined) => {
      entered.resolve()
      await release.promise
      setupError = failure === "unrelated" ? new Error("Independent setup failure") : new Error("Setup cancelled", { cause: signal?.reason })
      throw setupError
    }
    const runId = `setup-failure-${kind}-${capacity}-${stage}-${failure}`
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      invocations,
      driver: { capacity: capacity ? { concurrency: 1 } : undefined, run: driver },
      capabilities: [defineCapability({ id: "setup", close, prepare: stage === "prepare" ? context => suspend(context.input.get().abortSignal) : undefined })],
      hooks: { "agent:input": stage === "hook" ? context => suspend(context.input.abortSignal) : undefined },
    })
    const running = kind === "run" ? runAgent(agent, runtime(runId), {}) : streamAgent(agent, runtime(runId), {})
    const settled = running.then(() => undefined, error => error)
    await entered.promise
    const id = await agentInvocationId(runId)
    expect(await invocations.cancel(id)).toMatchObject({ delivery: "local", outcome: "requested" })
    release.resolve()
    expect(await settled).toBe(setupError)
    expect(driver).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    const record = await invocations.get(id)
    expect(record?.status).toBe(failure === "unrelated" ? "failed" : "cancelled")
    expect(record?.error?.message).toBe(setupError?.message)
  })

  it.each(["run", "stream"] as const)("stops %s dispatch when cancellation arrives during input preparation", async (kind) => {
    const entered = deferred()
    const release = deferred()
    const close = vi.fn()
    const driver = vi.fn(() => "Must not run")
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const runId = `input-preparation-cancel-${kind}`
    const agent = defineAgent({
      invocations,
      driver: { run: driver },
      capabilities: [defineCapability({ id: "cleanup", close })],
      hooks: {
        "agent:input": async () => { entered.resolve(); await release.promise },
      },
    })
    const running = kind === "run" ? runAgent(agent, runtime(runId), {}) : streamAgent(agent, runtime(runId), {})
    const settled = running.then(() => undefined, error => error)
    await entered.promise
    const id = await agentInvocationId(runId)
    expect(await invocations.cancel(id)).toMatchObject({ delivery: "local", outcome: "requested" })
    release.resolve()
    expect(await settled).toBeInstanceOf(Error)
    expect(driver).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    expect((await invocations.get(id))?.status).toBe("cancelled")
  })

  it("stops startup when cancellation wins its initial claim", async () => {
    const backing = createMemoryAgentInvocationStore()
    const entered = deferred()
    const release = deferred()
    let waiting = true
    const store = {
      ...backing,
      async claim(...args: Parameters<typeof backing.claim>) {
        if (waiting && !args[1].startsWith("cancel_")) {
          waiting = false
          entered.resolve()
          await release.promise
        }
        return await backing.claim(...args)
      },
    }
    const invocations = defineAgentInvocations({ store })
    const driver = vi.fn(() => "Must not run")
    const running = runAgent(defineAgent({ invocations, driver: { run: driver } }), runtime("startup-cancel"), {})
    const rejection = expect(running).rejects.toThrow()
    await entered.promise
    const id = await agentInvocationId("startup-cancel")
    expect(await invocations.cancel(id)).toMatchObject({ outcome: "requested" })
    release.resolve()
    await rejection
    expect(driver).not.toHaveBeenCalled()
  })

  it("isolates matching Invocation IDs across independent stores", async () => {
    const firstRelease = deferred<string>()
    const secondRelease = deferred<string>()
    let firstSignal: AbortSignal | undefined
    let secondSignal: AbortSignal | undefined
    const first = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const second = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const firstRun = runAgent(defineAgent({ invocations: first, driver: { run: ({ input }) => { firstSignal = input.abortSignal; return firstRelease.promise } } }), runtime("same-id"), {})
    const secondRun = runAgent(defineAgent({ invocations: second, driver: { run: ({ input }) => { secondSignal = input.abortSignal; return secondRelease.promise } } }), runtime("same-id"), {})
    const { id } = await recordWithStatus(first, "same-id", "running")
    await recordWithStatus(second, "same-id", "running")
    await vi.waitFor(() => expect(secondSignal).toBeDefined())
    await first.cancel(id)
    expect(firstSignal?.aborted).toBe(true)
    expect(secondSignal?.aborted).toBe(false)
    firstRelease.resolve("First")
    secondRelease.resolve("Second")
    await Promise.all([firstRun, secondRun])
  })

  it("does not terminalize running work after its lease expires", async () => {
    const backing = createMemoryAgentInvocationStore()
    const store = {
      ...backing,
      claim: (...args: Parameters<typeof backing.claim>) => backing.claim(args[0], args[1], 1, args[3]),
    }
    const invocations = defineAgentInvocations({ store })
    const release = deferred<string>()
    const started = deferred()
    const run = runAgent(defineAgent({ invocations, driver: { run: () => {
      started.resolve()
      return release.promise
    } } }), runtime("expired-owner"), {})
    await started.promise
    const { id } = await recordWithStatus(invocations, "expired-owner", "running")
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(await invocations.cancel(id)).toMatchObject({ outcome: "requested", status: "running" })
    expect((await invocations.get(id))?.status).toBe("running")
    release.resolve("Done.")
    await expect(run).resolves.toBe("Done.")
    expect((await invocations.get(id))?.status).toBe("completed")
  })

  it.each(["completed", "failed", "cancelled"] as const)("aborts a stale local owner when cancel sees a %s record after lease loss", async status => {
    vi.useFakeTimers()
    const backing = createMemoryAgentInvocationStore()
    let rejectClaims = false
    const store = { ...backing, claim: (...args: Parameters<typeof backing.claim>) => rejectClaims ? false : backing.claim(...args) }
    const invocations = defineAgentInvocations({ store })
    const runId = `stale-terminal-owner-${status}`
    const journal = await bindAgentInvocations(invocations, runtime(runId))
    if (!journal) throw new Error("Expected invocation journal")
    journal.watchCancellation({ enforced: true, name: "model" })
    try {
      await journal.running()
      const id = await agentInvocationId(runId)
      rejectClaims = true
      await vi.advanceTimersByTimeAsync(10_000)
      expect(journal.abortSignal.aborted).toBe(false)
      await backing.update(id, { status, timestamp: new Date().toISOString() })
      expect(await invocations.cancel(id)).toEqual({ delivery: "local", id, outcome: "terminal", status })
      expect(journal.abortSignal.aborted).toBe(true)
      expect((await backing.get(id))?.status).toBe(status)
      expect((await backing.get(id))?.cancelRequestedAt).toBeUndefined()
    }
    finally { await journal.finish("cancelled") }
  })

  it.each((["completed", "failed", "cancelled"] as const).flatMap(status => [false, true].map(renewed => ({ renewed, status }))))("reports an unenforced local abort for an active custom run with a $status journal after renewal=$renewed", async ({ renewed, status }) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    const backing = createMemoryAgentInvocationStore()
    let rejectClaims = false
    const store = { ...backing, claim: (...args: Parameters<typeof backing.claim>) => rejectClaims ? false : backing.claim(...args) }
    const invocations = defineAgentInvocations({ store })
    const release = deferred<string>()
    let signal: AbortSignal | undefined
    let ended = false
    let activeTraceLog: import("../src/types.ts").AgentRuntimeContext["traceLog"]
    const runId = `stale-custom-warning-${status}-${renewed}`
    const run = runAgent(defineAgent({ invocations, driver: { run: async ({ input, traceLog }) => {
      activeTraceLog = traceLog
      signal = input.abortSignal
      const result = await release.promise
      ended = true
      return result
    } } }), runtime(runId), {})
    const { id } = await recordWithStatus(invocations, runId, "running")
    await vi.waitFor(() => expect(signal).toBeDefined())
    try {
      rejectClaims = true
      await vi.advanceTimersByTimeAsync(10_000)
      await backing.update(id, { status, timestamp: new Date().toISOString() })
      const terminalRecord = await backing.get(id)
      if (renewed) {
        rejectClaims = false
        await vi.advanceTimersByTimeAsync(10_000)
        // Resume a journal write through the active run's Trace log to observe terminal renewal.
        await activeTraceLog?.append({ name: "stale-owner-evidence", type: "run" })
        await vi.waitFor(() => expect(signal?.aborted).toBe(true))
      }
      expect(await invocations.cancel(id)).toEqual({ delivery: "local", id, notEnforcedBy: "run", outcome: "terminal", status })
      expect(signal?.aborted).toBe(true)
      expect(ended).toBe(false)
      expect(await backing.get(id)).toEqual(terminalRecord)
      rejectClaims = false
      release.resolve("Late custom result")
      await expect(run).resolves.toBe("Late custom result")
      expect(await backing.get(id)).toEqual(terminalRecord)
      expect(await invocations.cancel(id)).toEqual({ id, outcome: "terminal", status })
    }
    finally {
      rejectClaims = false
      release.resolve("Late custom result")
      await run
    }
  })

  it.each(["completed", "failed", "cancelled"] as const)("aborts the stale Driver before unregistering after terminal renewal: %s", async status => {
    vi.useFakeTimers()
    const backing = createMemoryAgentInvocationStore()
    let rejectClaims = false
    const store = { ...backing, claim: (...args: Parameters<typeof backing.claim>) => rejectClaims ? false : backing.claim(...args) }
    const invocations = defineAgentInvocations({ store })
    const runId = `terminal-renewal-handle-${status}`
    const journal = await bindAgentInvocations(invocations, runtime(runId))
    if (!journal) throw new Error("Expected invocation journal")
    journal.watchCancellation({ enforced: true, name: "model" })
    try {
      await journal.running()
      const id = await agentInvocationId(runId)
      rejectClaims = true
      await vi.advanceTimersByTimeAsync(10_000)
      expect(journal.abortSignal.aborted).toBe(false)
      await backing.update(id, { status, timestamp: new Date().toISOString() })
      const terminalRecord = await backing.get(id)
      rejectClaims = false
      await journal.setAnnotations({ source: "renewal" })
      expect(journal.abortSignal.aborted).toBe(true)
      expect(abortLocalAgentInvocation(store, id, new Error("obsolete owner"))).toEqual({ aborted: false })
      await journal.finish("cancelled")
      expect(await backing.get(id)).toEqual(terminalRecord)
    }
    finally { await journal.finish("cancelled") }
  })

  it("keeps local cancellation observable while terminal persistence waits", async () => {
    const backing = createMemoryAgentInvocationStore()
    const entered = deferred()
    const release = deferred()
    const store = {
      ...backing,
      async update(...args: Parameters<typeof backing.update>) {
        if (args[1].status === "completed") {
          entered.resolve()
          await release.promise
        }
        return await backing.update(...args)
      },
    }
    const invocations = defineAgentInvocations({ store })
    let signal: AbortSignal | undefined
    const run = runAgent(defineAgent({ invocations, driver: { run: ({ input }) => {
      signal = input.abortSignal
      return "Done."
    } } }), runtime("finishing-cancel"), {})
    await entered.promise
    const id = await agentInvocationId("finishing-cancel")
    try {
      expect(await invocations.cancel(id)).toMatchObject({ delivery: "local", outcome: "requested", status: "running" })
      expect(signal?.aborted).toBe(true)
    }
    finally {
      release.resolve()
    }
    await expect(run).resolves.toBe("Done.")
    expect((await invocations.get(id))?.status).toBe("completed")
  })

  it("reports a concurrent terminal transition after storing the request", async () => {
    const backing = createMemoryAgentInvocationStore()
    const requested = deferred()
    const requestRelease = deferred()
    const driverRelease = deferred<string>()
    const store = {
      ...backing,
      async update(...args: Parameters<typeof backing.update>) {
        const result = await backing.update(...args)
        if (args[1].cancelRequestedAt) {
          requested.resolve()
          await requestRelease.promise
        }
        return result
      },
    }
    const invocations = defineAgentInvocations({ store })
    const run = runAgent(defineAgent({ invocations, driver: { run: () => driverRelease.promise } }), runtime("terminal-race"), {})
    const { id } = await recordWithStatus(invocations, "terminal-race", "running")
    const cancel = invocations.cancel(id)
    await requested.promise
    driverRelease.resolve("Done.")
    await run
    requestRelease.resolve()
    expect(await cancel).toEqual({ id, outcome: "terminal", status: "completed" })
  })

  it("reports missing Invocations", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    expect(await invocations.cancel("missing")).toEqual({ id: "missing", outcome: "not-found" })
  })
})
