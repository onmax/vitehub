import { afterEach, expect, it, vi } from "vitest"
import * as v from "valibot"

import { defineCollection } from "../../source/src/index.ts"
import { defineChannel, defineChannelTrigger } from "../src/channels.ts"
import { defineAgent, workflow } from "../src/index.ts"
import { setAgentWorkflowRuntimeLoaders } from "../src/internal/workflow-runtime-loaders.ts"
import { bindAgentInvocations, createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"
import { channelMessageRunId, replayChannel } from "../src/channel-replay.ts"

afterEach(() => {
  setAgentWorkflowRuntimeLoaders({
    state: () => import("@vite-hub/workflow/runtime/state"),
    workflow: () => import("@vite-hub/workflow"),
  })
})

it("reserves concurrent Workflow replays before activity and hands the journal to the worker", async () => {
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {} }
  let entered = 0
  let release!: () => void
  const ready = new Promise<void>((resolve) => { release = resolve })
  const update = vi.fn()
  const channel = defineChannel("mailbox", {
    activity: { update },
    history: {
      collection: defineCollection(async () => [{ id: "m1" }], { cursor: item => item.id, cursorSchema: v.string() }),
      key: item => item.id,
    },
    triggers: {
      received: defineChannelTrigger({
        input: v.object({ id: v.string() }),
        invoke: async () => {
          if (++entered === 2) release()
          await ready
          return { input: { prompt: "hello" }, run: { runId: "trigger-run", channelId: "mailbox", activity: { target: { message: "m1" } } } }
        },
      }),
    },
  })
  const providerRun = vi.fn(async (_payload: unknown, options: { id: string }) => {
    const workerJournal = await bindAgentInvocations(invocations, { ...runtime, run: { runId: options.id } }, { agentName: "replay-workflow" })
    expect(workerJournal?.claimStatus).toBe("owned")
    await workerJournal?.running()
    await workerJournal?.finish("completed")
    return { id: options.id, provider: "vercel", status: "completed", result: "done" }
  })
  setAgentWorkflowRuntimeLoaders({
    state: async () => ({ ...await import("@vite-hub/workflow/runtime/state"), getWorkflowRuntimeConfig: () => ({ provider: "openworkflow" as const }) }),
    workflow: async () => ({
      ...await import("@vite-hub/workflow"),
      // SAFETY: The fixture only uses the Workflow handle's run operation.
      createWorkflow: () => ({ run: providerRun }) as never,
    }),
  })
  const agent = defineAgent({ channels: { mailbox: channel }, driver: { run: () => "unused" }, invocations, name: "replay-workflow", runtime: workflow("replay-workflow") })
  const results = await Promise.all([replayChannel(agent, "mailbox", { runtime }), replayChannel(agent, "mailbox", { runtime })])
  expect(update.mock.calls.filter(([context]) => context.activity.status === "queued")).toHaveLength(1)
  expect(providerRun).toHaveBeenCalledTimes(1)
  expect(results.reduce((sum, result) => sum + result.processed, 0)).toBe(1)
  expect(results.reduce((sum, result) => sum + result.skipped, 0)).toBe(1)
  expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(0)
  await expect(invocations.getByRunId(channelMessageRunId("mailbox", "m1"), "replay-workflow")).resolves.toMatchObject({ status: "completed" })
})
