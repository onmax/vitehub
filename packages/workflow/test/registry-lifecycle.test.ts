import { afterEach, expect, it, vi } from "vitest"

import { createWorkflow, runWorkflow } from "../src/runtime/client.ts"
import { resetWorkflowRuntime, setWorkflowRuntimeRegistry, takeInlineWorkflowDefinition, takeInlineWorkflowDefinitionForModule } from "../src/runtime/state.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

afterEach(() => resetWorkflowRuntime())

it.each(["replace", "reset"])("isolates pending definitions when the runtime registry is %s", async (operation) => {
  const started = deferred()
  const release = deferred()
  const oldHandler = vi.fn(() => "old")
  const newHandler = vi.fn(() => "new")
  const newLoader = vi.fn(async () => ({ handler: newHandler }))
  setWorkflowRuntimeRegistry({
    report: async () => {
      started.resolve()
      await release.promise
      return { handler: oldHandler }
    },
  })
  const oldRun = runWorkflow("report")
  await started.promise
  if (operation === "reset") resetWorkflowRuntime()
  setWorkflowRuntimeRegistry({ report: newLoader })
  const newRun = runWorkflow("report")
  // Let both loads start before allowing the old registry to finish.
  await Promise.resolve()
  release.resolve()
  await Promise.all([oldRun, newRun])
  await runWorkflow("report")

  expect(newLoader).toHaveBeenCalledTimes(1)
  expect(oldHandler).toHaveBeenCalledTimes(1)
  expect(newHandler).toHaveBeenCalledTimes(2)
})

it("keeps a replacement load shared when an earlier registry finishes", async () => {
  const oldStarted = deferred()
  const releaseOld = deferred()
  const newStarted = deferred()
  const releaseNew = deferred()
  const oldHandler = vi.fn(() => "old")
  const newHandler = vi.fn(() => "new")
  setWorkflowRuntimeRegistry({
    report: async () => {
      oldStarted.resolve()
      await releaseOld.promise
      return { handler: oldHandler }
    },
  })
  const oldRun = runWorkflow("report")
  await oldStarted.promise
  resetWorkflowRuntime()
  const newLoader = vi.fn(async () => {
    newStarted.resolve()
    await releaseNew.promise
    return { handler: newHandler }
  })
  setWorkflowRuntimeRegistry({ report: newLoader })
  const newRun = runWorkflow("report")
  await newStarted.promise
  releaseOld.resolve()
  await oldRun
  const concurrentRun = runWorkflow("report")
  releaseNew.resolve()
  await Promise.all([newRun, concurrentRun])

  expect(newLoader).toHaveBeenCalledTimes(1)
  expect(oldHandler).toHaveBeenCalledTimes(1)
  expect(newHandler).toHaveBeenCalledTimes(2)
})

it("retries a failed loader and preserves standalone inline definitions across replacement", async () => {
  const inlineHandler = vi.fn(() => "inline")
  const handle = createWorkflow("inline", inlineHandler)
  const handler = vi.fn(() => "loaded")
  const loader = vi.fn()
    .mockRejectedValueOnce(new Error("temporary import failure"))
    .mockResolvedValue({ handler })
  setWorkflowRuntimeRegistry({ report: loader })
  await expect(runWorkflow("report")).rejects.toThrow("temporary import failure")
  await Promise.all([runWorkflow("report"), runWorkflow("report")])
  setWorkflowRuntimeRegistry({})
  await handle.run()

  expect(loader).toHaveBeenCalledTimes(2)
  expect(handler).toHaveBeenCalledTimes(2)
  expect(inlineHandler).toHaveBeenCalledTimes(1)
})

it.each(["before", "after"])("isolates inline registration made %s a registry replacement", async (timing) => {
  const started = deferred()
  const release = deferred()
  const oldHandler = vi.fn(() => "old")
  const newHandler = vi.fn(() => "new")
  setWorkflowRuntimeRegistry({
    report: async () => {
      if (timing === "before") createWorkflow("report", oldHandler)
      started.resolve()
      await release.promise
      if (timing === "after") createWorkflow("report", oldHandler)
      return {}
    },
  })
  const oldRun = runWorkflow("report")
  await started.promise
  setWorkflowRuntimeRegistry({ report: async () => ({ handler: newHandler }) })
  await runWorkflow("report")
  const standaloneHandler = vi.fn(() => "standalone")
  const standalone = createWorkflow("helper", standaloneHandler)
  release.resolve()
  await oldRun
  await runWorkflow("report")
  await standalone.run()

  expect(oldHandler).toHaveBeenCalledTimes(1)
  expect(newHandler).toHaveBeenCalledTimes(2)
  expect(standaloneHandler).toHaveBeenCalledTimes(1)
})

it("does not publish helper definitions from a retired loader after reset", async () => {
  const started = deferred()
  const release = deferred()
  const oldHandler = vi.fn(() => "old")
  setWorkflowRuntimeRegistry({
    report: async () => {
      started.resolve()
      await release.promise
      const helper = createWorkflow("helper", oldHandler)
      return { helper }
    },
  })
  const oldRun = runWorkflow("report")
  await started.promise
  resetWorkflowRuntime()
  const currentHandler = vi.fn(() => "current")
  const current = createWorkflow("helper", currentHandler)
  release.resolve()
  await oldRun
  await current.run()

  expect(oldHandler).toHaveBeenCalledTimes(1)
  expect(currentHandler).toHaveBeenCalledTimes(1)
})

it("does not let retired loaders take current inline definitions", async () => {
  const started = deferred()
  const release = deferred()
  const oldHandler = vi.fn(() => "old")
  setWorkflowRuntimeRegistry({
    report: async () => {
      started.resolve()
      await release.promise
      expect(takeInlineWorkflowDefinition("helper")).toBeUndefined()
      expect(takeInlineWorkflowDefinitionForModule("helper", {})).toBeUndefined()
      return { handler: oldHandler }
    },
  })
  const oldRun = runWorkflow("report")
  await started.promise
  resetWorkflowRuntime()
  const handler = vi.fn(() => "current")
  const current = createWorkflow("helper", handler)
  release.resolve()
  await oldRun
  await current.run()
  expect(handler).toHaveBeenCalledTimes(1)
})

it("resolves an inline export that was registered before its module loader", async () => {
  const handler = vi.fn(() => "cached module")
  const workflow = createWorkflow("legacy-name", handler)
  setWorkflowRuntimeRegistry({
    report: async () => takeInlineWorkflowDefinitionForModule("report", { workflow })!,
  })
  await runWorkflow("report")
  expect(handler).toHaveBeenCalledTimes(1)
})

it("does not revive cached inline exports after reset", async () => {
  const handler = vi.fn(() => "stale")
  const workflow = createWorkflow("legacy-name", handler)
  const registry = {
    report: async () => ({ workflow }),
  }
  setWorkflowRuntimeRegistry(registry)
  await runWorkflow("report")

  resetWorkflowRuntime()
  setWorkflowRuntimeRegistry(registry)
  await expect(runWorkflow("report")).rejects.toMatchObject({ code: "WORKFLOW_DEFINITION_NOT_FOUND" })
  expect(handler).toHaveBeenCalledTimes(1)
})

it("does not revive handles created by a retired loader after reset", async () => {
  const started = deferred()
  const release = deferred()
  const handler = vi.fn(() => "retired")
  let module: Promise<{ workflow: ReturnType<typeof createWorkflow> }> | undefined
  const registry = {
    report: () => module ??= (async () => {
      started.resolve()
      await release.promise
      return { workflow: createWorkflow("legacy-name", handler) }
    })(),
  }
  setWorkflowRuntimeRegistry(registry)
  const oldRun = runWorkflow("report")
  await started.promise
  resetWorkflowRuntime()
  setWorkflowRuntimeRegistry(registry)
  release.resolve()
  await oldRun

  await expect(runWorkflow("report")).rejects.toMatchObject({ code: "WORKFLOW_DEFINITION_NOT_FOUND" })
  expect(handler).toHaveBeenCalledTimes(1)
})

it("retries a failed import after it partially registered an inline definition", async () => {
  const handler = vi.fn(() => "retried")
  let fail = true
  const loader = vi.fn(async () => {
    const report = createWorkflow("report", handler)
    if (fail) {
      fail = false
      throw new Error("import failed after registration")
    }
    return { report }
  })
  setWorkflowRuntimeRegistry({ report: loader })
  await expect(runWorkflow("report")).rejects.toThrow("import failed after registration")
  await runWorkflow("report")
  expect(loader).toHaveBeenCalledTimes(2)
  expect(handler).toHaveBeenCalledTimes(1)
})

it.each(["before", "after"])("recovers shared inline module imports registered %s replacement", async (timing) => {
  const started = deferred()
  const release = deferred()
  const handler = vi.fn(() => "shared")
  let module: Promise<{ workflow: ReturnType<typeof createWorkflow> }> | undefined
  const registry = {
    report: () => module ??= (async () => {
      const early = timing === "before" ? createWorkflow("legacy-name", handler) : undefined
      started.resolve()
      await release.promise
      return { workflow: early ?? createWorkflow("legacy-name", handler) }
    })(),
  }
  setWorkflowRuntimeRegistry(registry)
  const oldRun = runWorkflow("report")
  await started.promise
  setWorkflowRuntimeRegistry(registry)
  const currentRun = runWorkflow("report")
  release.resolve()
  await Promise.all([oldRun, currentRun])
  await runWorkflow("report")
  expect(handler).toHaveBeenCalledTimes(3)
})
