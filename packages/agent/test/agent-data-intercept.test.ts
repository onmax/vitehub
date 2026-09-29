import { createTraceEventLog } from "@vite-hub/runtime"
import * as v from "valibot"
import { describe, expect, it, vi } from "vitest"

import { defineAgent, defineCapability, runAgent, runAgentInline } from "../src/index.ts"

const emailSchema = v.object({
  from: v.string(),
  subject: v.string(),
})

const decisionSchema = v.object({ label: v.string() })

function runtime(content: "content" | "metadata" = "content") {
  return {
    memo: <T>(_key: string, create: () => T) => create(),
    runtime: "unknown" as const,
    traceLog: createTraceEventLog({ content }),
    waitUntil: vi.fn(),
  }
}

// Custom-run Drivers receive the parsed data as `unknown`.
function labeller(run = vi.fn((_context: { input: { data?: unknown } }) => ({ label: "jev" })), finish = vi.fn()) {
  return defineAgent({
    data: emailSchema,
    driver: { output: { schema: decisionSchema }, run },
    hooks: { "agent:finish": finish },
    intercept: ({ data }) => data.from.endsWith("@github.com") ? { rule: "github", label: "GitHub" } : undefined,
    runtime: false,
  })
}

describe("Agent data and intercept", () => {
  it("rejects invalid data before the Driver runs", async () => {
    const run = vi.fn(() => ({ label: "jev" }))
    const intercept = vi.fn(() => undefined)
    const agent = defineAgent({
      data: emailSchema,
      driver: { run },
      intercept,
      runtime: false,
    })

    // @ts-expect-error The data schema requires a subject.
    const [error, output] = await runAgent(agent, { data: { from: "a@example.com" } })

    expect(output).toBeNull()
    expect(error?.message).toContain("Invalid Agent input data")
    expect(intercept).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("finishes with the intercepted value and skips the Driver", async () => {
    const run = vi.fn((_context: { input: { data?: unknown } }) => ({ label: "jev" }))
    const finish = vi.fn()
    const context = runtime()
    const output = await runAgentInline(labeller(run, finish), context, {
      data: { from: "notifications@github.com", subject: "PR merged" },
      prompt: "notifications@github.com: PR merged",
    })

    expect(output).toEqual({ label: "GitHub", rule: "github" })
    expect(run).not.toHaveBeenCalled()
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ data: { from: "notifications@github.com", subject: "PR merged" } }),
      result: { label: "GitHub", rule: "github" },
    }))
    const finished = context.traceLog.entries().find(entry => entry.name === "agent.invocation.finish")
    expect(finished?.attributes).toMatchObject({
      "agent.intercepted": true,
      "result.output": { label: "GitHub", rule: "github" },
    })
  })

  it("continues to the Driver when intercept returns undefined", async () => {
    const run = vi.fn(({ input }: { input: { data?: unknown } }) => ({ label: `jev:${v.parse(emailSchema, input.data).subject}` }))
    const [error, output] = await runAgent(labeller(run), {
      data: { from: "friend@example.com", subject: "Dinner" },
    })

    expect(error).toBeNull()
    expect(output).toEqual({ label: "jev:Dinner" })
    expect(run).toHaveBeenCalledOnce()
  })

  it("passes parsed data to intercept, hooks, and the Driver", async () => {
    const seen: unknown[] = []
    const agent = defineAgent({
      data: v.object({ count: v.pipe(v.string(), v.transform(Number)) }),
      driver: { run: ({ input }) => { seen.push(input.data); return "ok" } },
      hooks: { "agent:input": ({ input }) => { seen.push(input.data) } },
      intercept: ({ data }) => { seen.push(data); return undefined },
      runtime: false,
    })

    await runAgentInline(agent, runtime(), { data: { count: "2" } })

    expect(seen).toEqual([{ count: 2 }, { count: 2 }, { count: 2 }])
  })

  it("validates data replaced by a Capability before hooks and intercept", async () => {
    const inputHook = vi.fn()
    const intercept = vi.fn(() => undefined)
    const run = vi.fn(() => "ok")
    const replaceData = defineCapability({
      id: "replace-data",
      input(context) {
        context.input.set({ ...context.input.get(), data: { from: "invalid" } })
      },
    })
    const agent = defineAgent({
      capabilities: [replaceData],
      data: emailSchema,
      driver: { run },
      hooks: { "agent:input": inputHook },
      intercept,
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { data: { from: "friend@example.com", subject: "Dinner" } })

    expect(error?.message).toContain("Invalid Agent input data")
    expect(output).toBeNull()
    expect(inputHook).not.toHaveBeenCalled()
    expect(intercept).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("lets a child Agent replace the parent data schema", async () => {
    const child = defineAgent({
      extends: labeller(),
      data: v.object({ from: v.string() }),
    })

    // @ts-expect-error The child schema requires from, not subject.
    const [error] = await runAgent(child, { data: { subject: "Hi" } })
    const [, output] = await runAgent(child, { data: { from: "a@github.com" } })

    expect(error?.message).toContain("Invalid Agent input data")
    expect(output).toEqual({ label: "GitHub", rule: "github" })
  })

  it("records data according to the trace content policy", async () => {
    const data = { from: "friend@example.com", subject: "private subject" }
    const contentRuntime = runtime("content")
    const metadataRuntime = runtime("metadata")

    await runAgentInline(labeller(), contentRuntime, { data })
    await runAgentInline(labeller(), metadataRuntime, { data })

    const contentStart = contentRuntime.traceLog.entries().find(entry => entry.name === "agent.invocation.start")
    const metadataStart = metadataRuntime.traceLog.entries().find(entry => entry.name === "agent.invocation.start")
    expect(contentStart?.attributes).toMatchObject({ "input.data": data, "input.hasData": true })
    expect(metadataStart?.attributes).toMatchObject({ "input.hasData": true })
    expect(JSON.stringify(metadataRuntime.traceLog.entries())).not.toContain("private subject")
  })
})
