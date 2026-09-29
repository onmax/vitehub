import { runAgent } from "@vite-hub/agent"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { defineAgent } from "../src/agent.ts"
import { installConsoleAgentDefinitions } from "../src/console/runtime/server/agents.ts"
import { createConsoleD1Invocations } from "../src/console/runtime/server/invocations.ts"

import type { AgentInvocationD1Database } from "@vite-hub/agent/invocations/d1"

describe("Console D1 journal", () => {
  let miniflare: Miniflare
  let database: AgentInvocationD1Database

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-14",
      d1Databases: ["DB"],
      modules: true,
      script: "export default { fetch() { return new Response('test') } }",
    })
    database = await miniflare.getD1Database("DB")
  })
  afterAll(async () => { await miniflare?.dispose() })

  it("journals Agents without their own journal into the Worker D1 binding and creates the table", { timeout: 30_000 }, async () => {
    const env = vi.fn(() => ({ DB: database }))
    const agent = defineAgent({ driver: { run: () => "done" }, name: "labeller", runtime: false })
    installConsoleAgentDefinitions([{ definition: agent, fallbackName: "labeller" }], {
      d1: { binding: "DB", env },
      projectRoot: "/console-d1-journal-test",
    })
    const invocations = agent.invocations
    if (!invocations) throw new Error("Expected the Console journal fallback.")

    await expect(runAgent(agent, { memo: vi.fn(), run: { runId: "d1-default" }, runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toBe("done")

    // Each journal write is bounded to one second and retried in the background, so wait for the terminal state.
    await vi.waitFor(async () => {
      await expect(invocations.getByRunId("d1-default", "labeller")).resolves.toMatchObject({ agentName: "labeller", status: "completed" })
    }, { timeout: 20_000 })
    const tables = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vitehub_agent_invocations'").all()
    expect(tables.results).toHaveLength(1)
    expect(env).toHaveBeenCalled()
  })

  it("reports a missing D1 binding", async () => {
    const invocations = createConsoleD1Invocations({ binding: "JOURNAL", env: () => ({}) })
    await expect(invocations.list()).rejects.toThrow("requires the D1 binding \"JOURNAL\"")
  })
})
