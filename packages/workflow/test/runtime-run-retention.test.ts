import { afterEach, describe, expect, it, vi } from "vitest"

import { createWorkflow } from "../src/runtime/client.ts"
import { getWorkflowRunState, resetWorkflowRuntime, setWorkflowRun, setWorkflowRuntimeConfig } from "../src/runtime/state.ts"

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => { resolve = accept })
  return { promise, resolve }
}

afterEach(() => {
  resetWorkflowRuntime()
  vi.useRealTimers()
})

describe("inline Workflow run retention", () => {
  it("keeps more than 1024 active runs inspectable through completion", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    const first = gate()
    const remaining = gate()
    const workflow = createWorkflow<boolean, string>("pending", async ({ payload }) => {
      await (payload ? first.promise : remaining.promise)
      return "done"
    })
    await workflow.run(true, { id: "first" })
    const firstState = getWorkflowRunState("pending", "first")!
    const started = await Promise.all(Array.from({ length: 1_024 }, (_, index) => workflow.run(false, { id: String(index) })))
    const pending = started.map(run => getWorkflowRunState("pending", run.id)!.promise)
    try {
      await expect(workflow.getRun("first")).resolves.toMatchObject({ status: "running" })
      first.resolve()
      await firstState.promise
      await expect(workflow.getRun("first")).resolves.toMatchObject({ result: expect.any(Response), status: "completed" })
    } finally {
      first.resolve()
      remaining.resolve()
      await Promise.all([firstState.promise, ...pending])
    }
  })

  it.each(["completed", "failed"] as const)("bounds %s history without evicting active runs", async (status) => {
    const active = gate()
    const state = setWorkflowRun("history", "active", active.promise.then(() => ({ status: "completed" as const })))
    for (let index = 0; index <= 1_024; index++) {
      await setWorkflowRun("history", String(index), Promise.resolve({ result: index, status })).promise
    }
    expect(getWorkflowRunState("history", "active")).toBe(state)
    expect(getWorkflowRunState("history", "0")).toBeUndefined()
    expect(getWorkflowRunState("history", "1")?.result).toBe(1)
    expect(getWorkflowRunState("history", "1024")?.result).toBe(1_024)
    active.resolve()
    await state.promise
    expect(getWorkflowRunState("history", "active")?.status).toBe("completed")
    expect(getWorkflowRunState("history", "1")).toBeUndefined()
  })

  it("expires completed runs after five minutes while retaining active runs", async () => {
    vi.useFakeTimers()
    const active = gate()
    const state = setWorkflowRun("history", "active", active.promise.then(() => ({ status: "completed" as const })))
    await setWorkflowRun("history", "done", Promise.resolve({ status: "completed" })).promise
    vi.setSystemTime(Date.now() + 5 * 60 * 1_000)
    expect(getWorkflowRunState("history", "done")).toBeUndefined()
    expect(getWorkflowRunState("history", "active")).toBe(state)
    active.resolve()
    await state.promise
  })

  it("keeps a replacement run when an older run with the same ID finishes", async () => {
    const old = gate()
    const oldState = setWorkflowRun("history", "shared", old.promise.then(() => ({ result: "old", status: "completed" as const })))
    const current = setWorkflowRun("history", "shared", Promise.resolve({ result: "new", status: "completed" }))
    await current.promise
    old.resolve()
    await oldState.promise
    expect(getWorkflowRunState("history", "shared")).toBe(current)
  })

  it("does not restore runs that complete after a runtime reset", async () => {
    const active = gate()
    const state = setWorkflowRun("history", "old", active.promise.then(() => ({ status: "completed" as const })))
    resetWorkflowRuntime()
    active.resolve()
    await state.promise
    expect(getWorkflowRunState("history", "old")).toBeUndefined()
  })
})
