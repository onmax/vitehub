import { runAgent } from "@vite-hub/agent"
import { eq } from "drizzle-orm"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest"

import { defineAgent } from "../src/agent.ts"
import { installConsoleAgentDefinitions } from "../src/console/runtime/server/agents.ts"
import { console as consoleRuntime } from "../src/console/server.ts"
import { createConsoleD1Invocations, installConsoleInvocations } from "../src/console/runtime/server/invocations.ts"

import type { AgentInvocationD1Database, AgentInvocationD1Statement } from "@vite-hub/agent/invocations/d1"

describe("Console D1 journal", () => {
  let miniflare: Miniflare
  let database: AgentInvocationD1Database

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-14",
      d1Databases: ["DB", "OTHER"],
      modules: true,
      script: "export default { fetch() { return new Response('test') } }",
    })
    database = await miniflare.getD1Database("DB")
  })
  afterAll(async () => { await miniflare?.dispose() })

  it("journals Agents without their own journal into the Worker D1 binding and creates the table", { timeout: 30_000 }, async () => {
    const env = vi.fn(async () => ({ DB: database }))
    const agent = defineAgent({ driver: { run: () => "done" }, name: "labeller", runtime: false })
    installConsoleAgentDefinitions([{ definition: agent, fallbackName: "labeller" }], {
      d1: { binding: "DB", env },
      projectRoot: "/console-d1-journal-test",
    })
    const invocations = agent.invocations
    if (!invocations) throw new Error("Expected the Console journal fallback.")
    const context = { memo: vi.fn(), run: { runId: "d1-default" }, runtime: "unknown", waitUntil: vi.fn() }
    const { db, schema } = consoleRuntime.resolve(context).invocations
    expectTypeOf<typeof schema.invocations.$inferInsert["search"]>().toEqualTypeOf<string>()
    expectTypeOf<typeof schema.invocations.$inferInsert["summary"]>().toEqualTypeOf<NonNullable<typeof schema.invocations.$inferInsert["summary"]>>()
    expect(schema.invocations.search.notNull).toBe(true)
    expect(schema.invocations.summary.notNull).toBe(true)
    // The database is usable before the first invocation write and initializes its schema.
    await expect(db.select().from(schema.invocations)).resolves.toEqual([])
    await expect(db.select().from(schema.invocations).get()).resolves.toBeUndefined()

    await expect(runAgent(agent, { memo: vi.fn(), run: { runId: "d1-default" }, runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toBe("done")

    // Each journal write is bounded to one second and retried in the background, so wait for the terminal state.
    await vi.waitFor(async () => {
      await expect(invocations.getByRunId("d1-default", "labeller")).resolves.toMatchObject({ agentName: "labeller", status: "completed" })
    }, { timeout: 20_000 })
    const tables = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vitehub_agent_invocations'").all()
    expect(tables.results).toHaveLength(1)
    const summary = await invocations.getByRunId("d1-default", "labeller")
    if (!summary) throw new Error("Expected the completed invocation.")
    const query = db.select().from(schema.invocations).where(eq(schema.invocations.id, summary.id))
    await expect(query.all()).resolves.toMatchObject([{ id: summary.id, agentName: "labeller", status: "completed", record: { id: summary.id } }])
    await expect(query.get()).resolves.toMatchObject({ id: summary.id, status: "completed" })
    await expect(db.query.invocations.findFirst({ where: eq(schema.invocations.id, summary.id) })).resolves.toMatchObject({ id: summary.id, status: "completed" })
    expect(env).toHaveBeenCalled()
  })

  it("resolves the D1 binding per Drizzle operation and initializes each database", async () => {
    let active = await miniflare.getD1Database("OTHER")
    installConsoleInvocations("/console-d1-request-bindings", undefined, undefined, undefined, {
      binding: "JOURNAL",
      env: async () => ({ JOURNAL: active }),
    })
    const { db, schema } = consoleRuntime.resolve({ memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }).invocations
    const record = {
      agentName: "binding-test",
      createdAt: "2026-09-30T00:00:00.000Z",
      id: "binding-marker",
      observations: [],
      status: "completed" as const,
      traceId: "binding-trace",
      updatedAt: "2026-09-30T00:00:00.000Z",
    }
    await db.insert(schema.invocations).values({ id: record.id, status: record.status, agentName: record.agentName, search: "", summary: record, updatedAt: record.updatedAt, record }).run()
    const query = db.select().from(schema.invocations).where(eq(schema.invocations.id, record.id))
    await expect(query.all()).resolves.toMatchObject([{ record }])
    await expect(db.batch([query])).resolves.toMatchObject([[{ record }]])
    await expect(db.batch([
      db.update(schema.invocations).set({ agentName: "rolled-back" }).where(eq(schema.invocations.id, record.id)),
      db.insert(schema.invocations).values({ id: record.id, status: record.status, agentName: record.agentName, search: "", summary: record, updatedAt: record.updatedAt, record }),
    ])).rejects.toThrow()
    await expect(query.all()).resolves.toMatchObject([{ agentName: record.agentName }])
    active = await miniflare.getD1Database("DB")
    await expect(query.all()).resolves.toEqual([])
    active = await miniflare.getD1Database("OTHER")
    await expect(query.all()).resolves.toMatchObject([{ record }])
  })

  it("reports a missing D1 binding", async () => {
    const invocations = createConsoleD1Invocations({ binding: "JOURNAL", env: () => ({}) })
    await expect(invocations.list()).rejects.toThrow("requires the D1 binding \"JOURNAL\"")
  })

  it("accepts null results for batch writes and keeps mixed read and returning results", async () => {
    const binding: AgentInvocationD1Database = {
      prepare: query => database.prepare(query),
      // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- Implements the D1 batch contract while reproducing an empty write response.
      async batch<T>(statements: AgentInvocationD1Statement[]) {
        const results = await database.batch<T>(statements)
        for (const result of results) {
          if (result.results.length === 0) Object.defineProperty(result, "results", { value: null })
        }
        return results
      },
    }
    installConsoleInvocations("/console-d1-null-results", undefined, undefined, undefined, {
      binding: "JOURNAL",
      env: () => ({ JOURNAL: binding }),
    })
    const { db, schema } = consoleRuntime.resolve({ memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }).invocations
    const record = { id: "null-batch-results", traceId: "null-batch-trace", status: "completed" as const, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z", observations: [] }
    const values = { id: record.id, status: record.status, search: "", summary: record, record }
    const results = await db.batch([
      db.insert(schema.invocations).values(values),
      db.update(schema.invocations).set({ agentName: "batch-write" }).where(eq(schema.invocations.id, record.id)),
      db.select().from(schema.invocations).where(eq(schema.invocations.id, record.id)),
      db.delete(schema.invocations).where(eq(schema.invocations.id, record.id)),
      db.insert(schema.invocations).values(values).returning({ id: schema.invocations.id }),
    ])
    expect(results).toMatchObject([{ rows: [] }, { rows: [] }, [{ agentName: "batch-write" }], { rows: [] }, [{ id: record.id }]])
    await expect(db.select().from(schema.invocations).where(eq(schema.invocations.id, record.id))).resolves.toMatchObject([{ id: record.id }])
  })

  it("rejects callback transactions before resolving D1 or running the callback", async () => {
    const env = vi.fn(() => ({ JOURNAL: database }))
    installConsoleInvocations("/console-d1-transaction", undefined, undefined, undefined, { binding: "JOURNAL", env })
    const { db, schema } = consoleRuntime.resolve({ memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }).invocations
    const callback = vi.fn(async (transaction: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
      await transaction.update(schema.invocations).set({ agentName: "uncommitted" })
      throw new Error("Roll back the write.")
    })
    await expect(db.transaction(callback)).rejects.toThrow("does not support db.transaction(). Use db.batch()")
    expect(callback).not.toHaveBeenCalled()
    expect(env).not.toHaveBeenCalled()
  })
})
