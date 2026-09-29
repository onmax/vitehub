import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { afterEach, describe, expect, it } from "vitest"

import { runAgentInvocationsCli } from "../src/internal/agent-invocations-cli.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"

import type { AgentInvocationStore, AgentInvocationStoreCreateInput } from "../src/invocations.ts"

const day = 24 * 60 * 60 * 1000
const ago = (milliseconds: number) => new Date(Date.now() - milliseconds).toISOString()
const invocation = (id: string, status: AgentInvocationStoreCreateInput["status"], updatedAt = ago(0)): AgentInvocationStoreCreateInput => ({
  createdAt: updatedAt,
  id,
  observations: [],
  status,
  traceId: `trace:${id}`,
  updatedAt,
})

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-invocation-deletion-"))
  directories.push(directory)
  return directory
}

async function seed(store: AgentInvocationStore) {
  await store.create(invocation("old-completed", "completed", ago(40 * day)))
  await store.create(invocation("old-failed", "failed", ago(35 * day)))
  await store.create(invocation("old-running", "running", ago(40 * day)))
  await store.create(invocation("recent-cancelled", "cancelled", ago(day)))
}

const stores = {
  libsql: async () => {
    const directory = await temporaryDirectory()
    return createLibsqlAgentInvocationStore({ maxAgeMs: false, maxRecords: false, url: `file:${join(directory, "journal.sqlite")}` })
  },
  memory: async () => createMemoryAgentInvocationStore(),
}

describe.each(Object.entries(stores))("%s Agent Invocation deletion", (_name, createStore) => {
  it("deletes only terminal records and reports missing and active records", async () => {
    const store = await createStore()
    const invocations = defineAgentInvocations({ store })
    await seed(store)

    await expect(invocations.delete("old-completed")).resolves.toBe("deleted")
    await expect(invocations.delete("old-completed")).resolves.toBe("not-found")
    await expect(invocations.delete("old-running")).resolves.toBe("not-terminal")
    await expect(invocations.get("old-completed")).resolves.toBeUndefined()
    await expect(invocations.get("old-running")).resolves.toMatchObject({ status: "running" })
  })

  it("prunes terminal records older than a cutoff and previews them with dryRun", async () => {
    const store = await createStore()
    const invocations = defineAgentInvocations({ store })
    await seed(store)

    const preview = await invocations.prune({ dryRun: true, olderThanMs: 30 * day })
    expect(preview).toEqual({ dryRun: true, ids: expect.arrayContaining(["old-completed", "old-failed"]) })
    expect(preview.ids).toHaveLength(2)
    await expect(invocations.get("old-completed")).resolves.toBeDefined()

    const pruned = await invocations.prune({ olderThanMs: 30 * day })
    expect(pruned.dryRun).toBe(false)
    expect([...pruned.ids].sort()).toEqual(["old-completed", "old-failed"])
    const remaining = (await invocations.list()).invocations.map(record => record.id).sort()
    expect(remaining).toEqual(["old-running", "recent-cancelled"])
  })

  it("rejects an invalid prune age", async () => {
    const invocations = defineAgentInvocations({ store: await createStore() })
    await expect(invocations.prune({ olderThanMs: -1 })).rejects.toThrow("olderThanMs must be a non-negative safe integer")
    await expect(invocations.prune({ olderThanMs: 1.5 })).rejects.toThrow("olderThanMs must be a non-negative safe integer")
  })
})

describe("Agent Invocation retention", () => {
  it("keeps every record when the memory store prunes without a cutoff", async () => {
    const store = createMemoryAgentInvocationStore()
    await seed(store)
    await expect(defineAgentInvocations({ store }).prune()).resolves.toEqual({ dryRun: false, ids: [] })
  })

  it("applies the SQLite store's configured retention when prune has no cutoff", async () => {
    const directory = await temporaryDirectory()
    const url = `file:${join(directory, "journal.sqlite")}`
    await seed(createLibsqlAgentInvocationStore({ maxAgeMs: false, maxRecords: false, url }))
    const bounded = defineAgentInvocations({ store: createLibsqlAgentInvocationStore({ maxAgeMs: 30 * day, maxRecords: false, url }) })

    expect([...(await bounded.prune({ dryRun: true })).ids].sort()).toEqual(["old-completed", "old-failed"])
    expect([...(await bounded.prune()).ids].sort()).toEqual(["old-completed", "old-failed"])

    const counted = defineAgentInvocations({ store: createLibsqlAgentInvocationStore({ maxAgeMs: false, maxRecords: 1, url }) })
    await counted.prune()
    const remaining = (await counted.list()).invocations.map(record => record.id).sort()
    expect(remaining).toEqual(["old-running", "recent-cancelled"])
  })

  it("removes the SQLite claim row with the deleted record", async () => {
    const directory = await temporaryDirectory()
    const client = createClient({ url: `file:${join(directory, "journal.sqlite")}` })
    try {
      const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
      await store.create(invocation("claimed", "completed"))
      expect(await store.claim("claimed", "owner", 30_000)).toBe(true)
      expect((await client.execute("SELECT id FROM vitehub_agent_invocations_claims")).rows).toHaveLength(1)

      await expect(store.delete!("claimed")).resolves.toBe("deleted")
      expect((await client.execute("SELECT id FROM vitehub_agent_invocations_claims")).rows).toHaveLength(0)
    }
    finally {
      client.close()
    }
  })

  it("reports a store without delete or prune support", async () => {
    const { delete: _delete, prune: _prune, ...store } = createMemoryAgentInvocationStore()
    const invocations = defineAgentInvocations({ store })
    await expect(invocations.delete("missing")).rejects.toThrow("does not support deletion")
    await expect(invocations.prune()).rejects.toThrow("does not support pruning")
  })
})

describe("vitehub agent invocations delete and prune", () => {
  function output() {
    const chunks = { stderr: "", stdout: "" }
    return {
      chunks,
      stderr: { write: (chunk: string | Uint8Array) => { chunks.stderr += String(chunk) } },
      stdout: { write: (chunk: string | Uint8Array) => { chunks.stdout += String(chunk) } },
    }
  }

  async function consoleJournal() {
    const rootDir = await temporaryDirectory()
    await mkdir(join(rootDir, ".vitehub/data"), { recursive: true })
    const url = `file:${join(rootDir, ".vitehub/data/console.sqlite")}`
    await seed(createLibsqlAgentInvocationStore({ maxAgeMs: false, maxRecords: false, url }))
    const read = defineAgentInvocations({ store: createLibsqlAgentInvocationStore({ maxAgeMs: false, maxRecords: false, url }) })
    return { read, rootDir }
  }

  it("deletes a terminal record from the default Console journal", async () => {
    const { read, rootDir } = await consoleJournal()
    const io = output()

    await expect(runAgentInvocationsCli(["delete", "old-completed"], { env: {}, rootDir, ...io })).resolves.toBe(0)
    expect(io.chunks.stdout).toBe("Deleted old-completed.\n")
    await expect(read.get("old-completed")).resolves.toBeUndefined()

    const json = output()
    await expect(runAgentInvocationsCli(["delete", "old-running", "--json"], { env: {}, rootDir, ...json })).resolves.toBe(1)
    expect(JSON.parse(json.chunks.stdout)).toEqual({ id: "old-running", outcome: "not-terminal" })

    const missing = output()
    await expect(runAgentInvocationsCli(["delete", "old-completed"], { env: {}, rootDir, ...missing })).resolves.toBe(1)
    expect(missing.chunks.stderr).toBe("Agent Invocation old-completed was not found.\n")
  })

  it("previews and prunes terminal records older than the requested age", async () => {
    const { read, rootDir } = await consoleJournal()
    const preview = output()

    await expect(runAgentInvocationsCli(["prune", "--older-than", "30d", "--dry-run", "--json"], { env: {}, rootDir, ...preview })).resolves.toBe(0)
    const planned = JSON.parse(preview.chunks.stdout)
    expect(planned).toMatchObject({ dryRun: true, olderThanMs: 30 * day })
    expect([...planned.ids].sort()).toEqual(["old-completed", "old-failed"])
    expect((await read.list()).invocations).toHaveLength(4)

    const pruned = output()
    await expect(runAgentInvocationsCli(["prune", "--older-than=36d"], { env: {}, rootDir, ...pruned })).resolves.toBe(0)
    expect(pruned.chunks.stdout).toMatch(/^old-completed\nDeleted 1 terminal Agent Invocation last updated before \S+\.\n$/)
    expect((await read.list()).invocations.map(record => record.id).sort()).toEqual(["old-failed", "old-running", "recent-cancelled"])
  })

  it("uses an explicit database path and rejects a missing journal without creating it", async () => {
    const { read, rootDir } = await consoleJournal()
    const elsewhere = await temporaryDirectory()
    const explicit = output()
    await expect(runAgentInvocationsCli(["prune", "--database", join(rootDir, ".vitehub/data/console.sqlite"), "--json"], { env: {}, rootDir: elsewhere, ...explicit })).resolves.toBe(0)
    expect([...JSON.parse(explicit.chunks.stdout).ids].sort()).toEqual(["old-completed", "old-failed"])
    expect((await read.list()).invocations).toHaveLength(2)

    const missing = output()
    await expect(runAgentInvocationsCli(["prune"], { env: {}, rootDir: elsewhere, ...missing })).resolves.toBe(1)
    expect(missing.chunks.stderr).toContain(`No Agent Invocation journal exists at ${join(elsewhere, ".vitehub/data/console.sqlite")}`)
  })

  it("rejects invalid durations and extra arguments", async () => {
    const duration = output()
    await expect(runAgentInvocationsCli(["prune", "--older-than", "soon"], { env: {}, ...duration })).resolves.toBe(1)
    expect(duration.chunks.stderr).toContain("--older-than requires a duration such as 90m, 12h, or 30d.")

    const extra = output()
    await expect(runAgentInvocationsCli(["prune", "old-completed"], { env: {}, ...extra })).resolves.toBe(1)
    expect(extra.chunks.stderr).toContain("Unexpected argument: old-completed.")

    const id = output()
    await expect(runAgentInvocationsCli(["delete"], { env: {}, ...id })).resolves.toBe(1)
    expect(id.chunks.stderr).toContain("delete requires an invocation id.")
  })

  it("does not print the remote database credentials", async () => {
    const io = output()
    const code = await runAgentInvocationsCli(["prune", "--database", "http://user:url-secret@127.0.0.1:9/journal?authToken=query-secret"], {
      env: { VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN: "token-secret" },
      ...io,
    })
    expect(code).toBe(1)
    const printed = `${io.chunks.stdout}${io.chunks.stderr}`
    expect(printed).not.toMatch(/url-secret|query-secret|token-secret/)
  })
})
