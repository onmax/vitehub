import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAgent, runAgentInline, startAgentInvocation, workflow } from "../src/index.ts"
import { setAgentWorkflowRuntimeLoaders } from "../src/internal/workflow-runtime-loaders.ts"
import { parsedAgentWorkflowInputDataContextKey, runAgentWorkflowDefinition } from "../src/runtime/workflow.ts"

vi.mock("#vitehub/agent/registry", () => ({ default: {} }))

afterEach(() => {
  setAgentWorkflowRuntimeLoaders({
    state: () => import("@vite-hub/workflow/runtime/state"),
    workflow: () => import("@vite-hub/workflow"),
  })
})

describe("durable Agent data handoff", () => {
  it("parses data once across preflight and the durable Workflow", async () => {
    const validate = vi.fn((value: string) => Number(value))
    const data = v.object({ count: v.pipe(v.string(), v.transform(validate)) })
    const run = vi.fn(({ input }: { input: { data?: unknown } }) => input.data)
    const agent = defineAgent({ data, driver: { run }, runtime: workflow("parsed-data-preflight") })
    let payload: unknown
    setAgentWorkflowRuntimeLoaders({
      state: async () => ({
        ...await import("@vite-hub/workflow/runtime/state"),
        getWorkflowRuntimeConfig: () => ({ provider: "openworkflow" as const }),
      }),
      workflow: async () => ({
        ...await import("@vite-hub/workflow"),
        createWorkflow: () => ({
          run: async (input: unknown) => {
            payload = input
            return { id: "parsed-data-preflight", provider: "openworkflow", status: "queued" }
          },
        }) as never,
      }),
    })

    await startAgentInvocation(agent, {
      memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn(),
    }, { data: { count: "2" } })

    expect(payload).toMatchObject({ input: { data: { count: 2 } }, parsedInputData: true })
    expect(validate).toHaveBeenCalledOnce()
    const result = await runAgentWorkflowDefinition(agent, {
      id: "parsed-data-preflight",
      name: "parsed-data-preflight",
      payload: payload as never,
      provider: "openworkflow",
    }, runAgentInline)

    expect(result).toEqual({ count: 2 })
    expect(validate).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()
  })

  it("passes pre-parsed data to the Driver without parsing it again", async () => {
    const validate = vi.fn((value: string) => Number(value))
    const data = v.object({ count: v.pipe(v.string(), v.transform(validate)) })
    const run = vi.fn(({ input }: { input: { data?: unknown } }) => input.data)
    const agent = defineAgent({ data, driver: { run }, runtime: false })
    const parsedData = v.parse(data, { count: "2" })

    const result = await runAgentWorkflowDefinition(agent, {
      id: "parsed-data",
      name: "parsed-data",
      payload: { input: { data: parsedData }, parsedInputData: true },
      provider: "cloudflare",
    }, runAgentInline)

    expect(result).toEqual({ count: 2 })
    expect(validate).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()
  })

  it("validates older payloads and ignores caller-supplied input context", async () => {
    const validate = vi.fn((value: string) => Number(value))
    const data = v.object({ count: v.pipe(v.string(), v.transform(validate)) })
    const agent = defineAgent({ data, driver: { run: ({ input }) => input.data }, runtime: false })
    const marker = "vitehub.agent.workflow.parsedInputData"
    const input = { context: { [marker]: true }, data: { count: "3" } }
    const result = await runAgentWorkflowDefinition(agent, {
      id: "legacy-data",
      name: "legacy-data",
      payload: { input },
      provider: "cloudflare",
    }, async (definition, context, workflowInput) => {
      expect(Reflect.get(context, parsedAgentWorkflowInputDataContextKey)).toBeUndefined()
      return runAgentInline(definition, context, workflowInput)
    })

    expect(result).toEqual({ count: 3 })
    expect(validate).toHaveBeenCalledOnce()
  })
})
