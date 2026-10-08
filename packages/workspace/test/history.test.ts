import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { runInNewContext } from "node:vm"
import { createClient } from "@libsql/client"
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql"
import { drizzle as drizzleD1 } from "drizzle-orm/d1"
import { sql } from "drizzle-orm"
import { Miniflare } from "miniflare"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createWorkspace, defineWorkspace, file, isWorkspaceConflict, useWorkspace } from "../src/index.ts"
import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "../src/blob-database.ts"
import { registerWorkspace } from "../src/test.ts"
import { resetWorkspaceRegistry } from "../src/core/registry.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { createDriver as createR2Driver } from "../../blob/src/drivers/cloudflare-native.ts"
import { setActiveCloudflareEnv } from "../../blob/src/runtime/state.ts"
import { createCloudflareD1HttpResolver } from "../../database/src/runtime/d1-http.ts"
import { ViteHubError } from "@vite-hub/runtime"
import { createWorkspaceSourceResolutionFacade } from "../src/sources/resolution.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import type { RuntimeDrizzleDatabase } from "@vite-hub/database"

const cleanup: Array<() => Promise<void> | void> = []
const migration = await readFile(new URL("fixtures/history.sql", import.meta.url), "utf8")

afterEach(async () => {
  resetWorkspaceRegistry()
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function setup(driver: "libsql" | "d1" | "d1-http", workspace = "drop-1") {
  await mkdir(join(homedir(), ".cache/fleet/tmp"), { recursive: true })
  const root = await mkdtemp(join(homedir(), ".cache/fleet/tmp/workspace-history-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  let database: RuntimeDrizzleDatabase<Record<string, unknown>>
  let blob = createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") }))
  if (driver === "libsql") {
    const client = createClient({ url: `file:${join(root, "history.sqlite")}` })
    cleanup.push(() => client.close())
    database = drizzleLibsql(client, { schema: workspaceHistorySchema })
  }
  else {
    const worker = new Miniflare({ compatibilityDate: "2026-07-14", d1Databases: ["DB"], r2Buckets: ["HISTORY_R2"], modules: true, script: "export default { fetch() { return new Response('history') } }" })
    cleanup.push(() => worker.dispose())
    const binding = await worker.getD1Database("DB")
    setActiveCloudflareEnv({ HISTORY_R2: await worker.getR2Bucket("HISTORY_R2") })
    cleanup.push(() => setActiveCloudflareEnv(undefined))
    blob = createBlobStorage(createR2Driver({ driver: "cloudflare-r2", binding: "HISTORY_R2" }))
    database = driver === "d1" ? drizzleD1(binding, { schema: workspaceHistorySchema }) : createCloudflareD1HttpResolver({
      name: "history", drizzle: {}, cloudflare: { databaseId: "history", http: { authToken: "test", url: "https://d1.test/raw" } },
    }, workspaceHistorySchema, async (_url, options) => {
      // SAFETY: The test transport receives only this resolver's serialized query payload.
      const payload = JSON.parse(String(options?.body)) as { sql: string, params: unknown[], batch?: Array<{ sql: string, params: unknown[] }> }
      const queries = payload.batch ?? [payload]
      try {
        const results = await binding.batch<Record<string, unknown>>(queries.map(query => binding.prepare(query.sql).bind(...query.params)))
        return Response.json({ success: true, result: results.map(result => ({ success: true, results: { rows: result.results.map(row => Object.values(row)) } })) })
      }
      catch (error) {
        return Response.json({ success: false, errors: [{ message: String(error) }] }, { status: 400 })
      }
    })()
  }
  for (const statement of migration.split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
  const uploads = vi.spyOn(blob, "put")
  const store = createBlobDatabaseWorkspaceStore({ blob, database, workspace })
  const facade = () => useWorkspace("history", { mode: "write", definition: { name: "history", store } })
  return { blob, database, store, uploads, facade, fresh: () => createBlobDatabaseWorkspaceStore({ blob, database, workspace }) }
}

function rawFiles(files: Record<string, string | Uint8Array>) {
  return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, { path, content }]))
}

describe.each(["libsql", "d1", "d1-http"] as const)("retained history on %s", { timeout: 30_000 }, (driver) => {
  it("commits, lists, opens, and reads immutable text and binary files after a reopen", async () => {
    const { store, facade, fresh } = await setup(driver)
    const workspace = facade()
    expect(await workspace.capabilities()).toMatchObject({ retainedHistory: true })
    expect(await workspace.history.head()).toBeNull()
    expect(await workspace.history.usage()).toEqual({ bytes: 0, objects: 0 })
    const binary = new Uint8Array([0, 255, 128, 10])
    const first = await workspace.history.commit({ ifHead: null, files: { "guide/start.md": "é", "image.bin": binary }, message: "publish", metadata: { actor: "maxi", labels: ["first"], source: { repository: "owner/repo" } } })
    expect(first).toMatchObject({ parentId: null, files: 2, bytes: 6, message: "publish", metadata: { actor: "maxi", source: { repository: "owner/repo" } } })
    expect(first.id).toMatch(/^[a-f0-9]{64}$/)
    const second = await workspace.history.commit({ ifHead: first.id, files: { "guide/start.md": "next" } })
    expect(second.parentId).toBe(first.id)
    const page = await workspace.history.list({ limit: 1 })
    expect(page.revisions).toEqual([second])
    expect(page.cursor).toBe(second.id)
    expect(await workspace.history.list({ cursor: page.cursor, limit: 1 })).toEqual({ revisions: [first] })
    const readonly = useWorkspace("history", { definition: { name: "history", store: fresh() } })
    const version = await readonly.history.open(first.id)
    expect(await version.stat("")).toMatchObject({ path: "", type: "directory" })
    expect(await store.stat("")).toMatchObject({ path: "", type: "directory" })
    expect(await version.readFile("guide/start.md")).toBe("é")
    expect(await version.readFile("image.bin", { encoding: "binary" })).toEqual(binary)
    expect(await version.stat("guide")).toMatchObject({ type: "directory" })
    expect(await version.stat("guide/start.md")).toMatchObject({ size: 2, mediaType: "text/markdown", digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(await version.list()).toMatchObject([{ path: "guide", type: "directory" }, { path: "image.bin", type: "file" }])
    expect((await version.list("", { recursive: true, exclude: ["guide"] })).map(entry => entry.path)).toEqual(["image.bin"])
    expect(await fresh().history.head()).toEqual(second)
    const latest = await store.history.open(second.id)
    await expect(latest.readFile("image.bin")).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" })
    expect(await version.readFile("image.bin", { encoding: "binary" })).toEqual(binary)
  })

  it("uploads each retained digest once, counts unique bytes, and keeps workspaces isolated", async () => {
    const { store, facade, uploads, blob, database } = await setup(driver)
    const workspace = facade()
    const first = await workspace.history.commit({ ifHead: null, files: { "a.txt": "same", "b.txt": "same" } })
    expect(uploads).toHaveBeenCalledTimes(1)
    const second = await workspace.history.commit({ ifHead: first.id, files: { "a.txt": "same", "c.txt": "new" } })
    expect(uploads).toHaveBeenCalledTimes(2)
    await workspace.history.commit({ ifHead: second.id, files: {} })
    expect(await workspace.history.usage()).toEqual({ bytes: 7, objects: 2 })
    const other = createBlobDatabaseWorkspaceStore({ blob, database, workspace: "drop-2" })
    const otherRevision = await other.history.commit({ ifHead: null, files: rawFiles({ "a.txt": "same" }), metadata: { source: ["raw-store"] } })
    expect(otherRevision.metadata).toEqual({ source: ["raw-store"] })
    expect(uploads).toHaveBeenCalledTimes(3)
    expect(uploads.mock.calls.map(([key]) => key)).toEqual(expect.arrayContaining([expect.stringMatching(/\/sha256\/[a-f0-9]{64}$/)]))
    await store.delete()
    expect(await store.history.usage()).toEqual({ bytes: 0, objects: 0 })
    expect(await store.history.list()).toEqual({ revisions: [] })
    expect(await other.history.usage()).toEqual({ bytes: 4, objects: 1 })
    expect(await (await other.history.open(otherRevision.id)).readFile("a.txt")).toBe("same")
    await store.delete()
    const [error, remaining] = await blob.list()
    expect(error).toBeNull()
    expect(remaining?.blobs).toHaveLength(1)
  })

  it("lets only one concurrent CAS win and excludes its losing candidate from the timeline and usage", async () => {
    const { store, fresh, blob, database } = await setup(driver)
    const first = await store.history.commit({ ifHead: null, files: rawFiles({ "a.txt": "base" }) })
    const originalHead = blob.head.bind(blob)
    let arrived = 0
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(blob, "head").mockImplementation(async (...args) => {
      const result = await originalHead(...args)
      arrived++
      if (arrived === 2) release()
      await barrier
      return result
    })
    const results = await Promise.allSettled([store, fresh()].map((candidate, index) => candidate.history.commit({ ifHead: first.id, files: rawFiles({ "a.txt": `candidate-${index}` }) })))
    const winners = results.filter(result => result.status === "fulfilled")
    const losers = results.filter(result => result.status === "rejected")
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(isWorkspaceConflict(losers[0]!.reason)).toBe(true)
    expect(losers[0]!.reason).toMatchObject({ details: { expected: first.id, actual: winners[0]!.value.id } })
    expect((await store.history.list()).revisions.map(revision => revision.id)).toEqual([winners[0]!.value.id, first.id])
    expect(await store.history.usage()).toEqual({ bytes: 15, objects: 2 })
    const candidates = await database.select().from(workspaceHistorySchema.workspaceHistoryRevisions)
    const losing = candidates.find(candidate => !candidate.published)!
    expect(losing).toBeDefined()
    await expect(store.history.open(losing.id)).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" })
    await store.delete()
    expect((await blob.list())[1]?.blobs).toEqual([])
  })

  it("preserves the previous head if manifest insertion fails in the atomic batch", async () => {
    const { store, database } = await setup(driver)
    const first = await store.history.commit({ ifHead: null, files: rawFiles({ "a.txt": "base" }) })
    await database.run(sql.raw("CREATE TRIGGER reject_publication BEFORE UPDATE OF published ON workspace_history_revisions BEGIN SELECT RAISE(ABORT, 'publication failed'); END"))
    await expect(store.history.commit({ ifHead: first.id, files: rawFiles({ "a.txt": "next" }) })).rejects.toThrow()
    expect(await store.history.head()).toEqual(first)
    expect((await store.history.list()).revisions).toEqual([first])
    expect(await store.history.usage()).toEqual({ bytes: 4, objects: 1 })
  })

  it("tombstones deletion before a paused upload can publish and cleans late bytes", async () => {
    const { store, blob, fresh } = await setup(driver)
    const originalPut = blob.put.bind(blob)
    let release!: () => void
    let reached!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { reached = resolve })
    vi.spyOn(blob, "put").mockImplementationOnce(async (...args) => {
      reached()
      await paused
      return await originalPut(...args)
    })
    const publication = store.history.commit({ ifHead: null, files: rawFiles({ "a.txt": "late" }) })
    const rejected = expect(publication).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" })
    await started
    await fresh().delete()
    release()
    await rejected
    expect((await blob.list())[1]?.blobs).toEqual([])
    await expect(fresh().history.commit({ ifHead: null, files: {} })).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" })
    // Simulate an upload accepted by Blob whose client stopped before its final deletion check.
    const [catalog] = await blob.list()
    expect(catalog).toBeNull()
    const key = vi.mocked(blob.put).mock.calls[0]![0]
    await originalPut(key, "abandoned late upload", { addRandomSuffix: false })
    await fresh().delete()
    expect((await blob.list())[1]?.blobs).toEqual([])
  })

  it("retries cleanup after a Blob outage and removes failed-publication objects", async () => {
    const { store, blob } = await setup(driver)
    const first = await store.history.commit({ ifHead: null, files: rawFiles({ "a.txt": "base" }) })
    await store.setMeta!("source-state", { private: true })
    vi.spyOn(blob, "put").mockResolvedValueOnce([new ViteHubBlobFailure(), undefined])
    await expect(store.history.commit({ ifHead: first.id, files: rawFiles({ "a.txt": "next" }) })).rejects.toThrow("injected")
    const originalDelete = blob.del.bind(blob)
    vi.spyOn(blob, "del").mockResolvedValueOnce([new ViteHubBlobFailure(), undefined])
    await expect(store.delete()).rejects.toThrow("injected")
    expect(await store.history.head()).toBeNull()
    expect(await store.getMeta!("source-state")).toBeUndefined()
    blob.del = originalDelete
    await store.delete()
    expect((await blob.list())[1]?.blobs).toEqual([])
  })

  it("rejects a staged write that resumes after another instance deletes the workspace", async () => {
    const { store, blob, fresh } = await setup(driver)
    await store.history.commit({ ifHead: null, files: rawFiles({ "a.txt": "base" }) })
    const originalGet = blob.get.bind(blob)
    let release!: () => void
    let reached!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { reached = resolve })
    vi.spyOn(blob, "get").mockImplementationOnce(async (...args) => {
      const result = await originalGet(...args)
      reached()
      await paused
      return result
    })
    const candidate = fresh()
    const write = candidate.writeFile("a.txt", { path: "a.txt", content: "late" })
    const rejected = expect(write).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" })
    await started
    await store.delete()
    release()
    await rejected
    await expect(candidate.history.head()).resolves.toBeNull()
  })

  it("supports staged Workspace writes, checkpoint, Session commit, and metadata across Store instances", async () => {
    const { store, fresh, facade } = await setup(driver)
    const workspace = facade()
    await workspace.fs.writeFile("a.txt", "draft")
    expect(await workspace.history.head()).toBeNull()
    await workspace.history.checkpoint({ message: "first" })
    const first = await workspace.history.head()
    expect(first?.message).toBe("first")
    expect((await fresh().readFile("a.txt"))?.content).toEqual(new TextEncoder().encode("draft"))
    await store.setMeta!("key", { value: 1 })
    expect(await fresh().getMeta!("key")).toEqual({ value: 1 })
    const session = await workspace.startSession()
    await session.writeFile("a.txt", "session")
    await session.commit({ message: "second" })
    expect((await workspace.history.head())?.parentId).toBe(first?.id)
    expect(await workspace.fs.readFile("a.txt")).toBe("session")
    await session.close()
  })

  it("keeps the previous draft when a write's final Database check fails", async () => {
    const { store, database } = await setup(driver)
    await store.writeFile("keep.txt", { path: "keep.txt", content: "accepted" })
    await store.mkdir("empty")
    const before = await store.stat("keep.txt")
    const select = database.select.bind(database)
    vi.spyOn(database, "select")
      .mockImplementationOnce(select)
      .mockImplementationOnce(select)
      .mockImplementationOnce(() => { throw new Error("injected Database failure") })
    await expect(store.writeFile("keep.txt", { path: "keep.txt", content: "rejected" })).rejects.toThrow("injected Database failure")
    expect(await store.readFile("keep.txt")).toMatchObject({ content: "accepted" })
    expect(await store.stat("keep.txt")).toEqual(before)
    expect(await store.stat("empty")).toMatchObject({ type: "directory" })
    await store.snapshot()
    const revision = await store.history.head()
    expect(await (await store.history.open(revision!.id)).readFile("keep.txt")).toBe("accepted")
  })

  it("accepts cross-realm binary content through both history entry points", async () => {
    const { store, facade, uploads } = await setup(driver)
    // SAFETY: This fixed VM expression creates exactly the declared byte array.
    const foreign: Uint8Array = runInNewContext("new Uint8Array([0, 255, 128])")
    expect(foreign).not.toBeInstanceOf(Uint8Array)
    const expected = new Uint8Array([0, 255, 128])
    const first = await facade().history.commit({ ifHead: null, files: { "foreign.bin": foreign } })
    const second = await store.history.commit({ ifHead: first.id, files: rawFiles({ "foreign.bin": foreign }) })
    foreign.fill(0)
    for (const revision of [first, second]) {
      expect(await (await store.history.open(revision.id)).readFile("foreign.bin", { encoding: "binary" })).toEqual(expected)
    }
    expect(uploads).toHaveBeenCalledTimes(1)
    expect(await store.history.usage()).toEqual({ bytes: 3, objects: 1 })
  })

  it("isolates binary buffers passed to and returned from staged writes", async () => {
    const { store } = await setup(driver)
    const expected = new Uint8Array([0, 255, 128])
    for (const conditional of [false, true]) {
      const path = `${conditional}.bin`
      const input = expected.slice()
      const file = { path, content: input }
      if (conditional) await store.writeFileConditional!(path, file, null)
      else await store.writeFile(path, file)
      input.fill(0)
      const firstRead = await store.readFile(path)
      expect(firstRead?.content).toEqual(expected)
      if (firstRead?.content instanceof Uint8Array) firstRead.content.fill(0)
      expect((await store.readFile(path))?.content).toEqual(expected)
    }
    await store.snapshot()
    const revision = await store.history.head()
    const view = await store.history.open(revision!.id)
    for (const conditional of [false, true]) expect(await view.readFile(`${conditional}.bin`, { encoding: "binary" })).toEqual(expected)
  })

  it("rejects spoofed byte views and accepts genuine tagged bytes", async () => {
    const { store, facade, uploads } = await setup(driver)
    for (const content of [new Uint16Array([0x1234]), new Int8Array([1]), new Uint8ClampedArray([1]), new DataView(new ArrayBuffer(2))]) {
      Object.defineProperty(content, Symbol.toStringTag, { value: "Uint8Array" })
      // @ts-expect-error Other binary views are invalid JavaScript inputs.
      await expect(facade().history.commit({ ifHead: null, files: { "invalid.bin": content } })).rejects.toThrow("Invalid history file content")
      // @ts-expect-error The raw Store must reject the same invalid inputs.
      await expect(store.history.commit({ ifHead: null, files: { "invalid.bin": { path: "invalid.bin", content } } })).rejects.toThrow("Invalid history file content")
    }
    expect(uploads).not.toHaveBeenCalled()
    const bytes = new Uint8Array([0, 255, 128])
    Object.defineProperty(bytes, Symbol.toStringTag, { value: "CustomBytes" })
    const revision = await facade().history.commit({ ifHead: null, files: { "valid.bin": bytes } })
    expect(await (await store.history.open(revision.id)).readFile("valid.bin", { encoding: "binary" })).toEqual(new Uint8Array([0, 255, 128]))
  })

  it("rejects non-string messages before uploads or publication", async () => {
    const { store, facade, uploads } = await setup(driver)
    for (const message of [1, null, {}, false]) {
      // @ts-expect-error The public boundary also validates untyped callers.
      await expect(facade().history.commit({ ifHead: null, files: { "a.txt": "new" }, message })).rejects.toThrow("message must be a string")
      // @ts-expect-error Raw Store commits must validate untyped callers too.
      await expect(store.history.commit({ ifHead: null, files: rawFiles({ "a.txt": "new" }), message })).rejects.toThrow("message must be a string")
    }
    expect(uploads).not.toHaveBeenCalled()
    expect(await store.history.head()).toBeNull()
    const revision = await facade().history.commit({ ifHead: null, files: {}, message: "" })
    expect(revision.message).toBe("")
    expect(await store.history.head()).toEqual(revision)
  })

  it("retains a 200-file folder and uploads no bytes for an unchanged publication", async () => {
    const { facade, uploads } = await setup(driver)
    const workspace = facade()
    const files = Object.fromEntries(Array.from({ length: 200 }, (_, index) => {
      const bytes = new Uint8Array(20 * 1024)
      bytes[0] = index
      return [`assets/file-${index}.bin`, bytes]
    }))
    const first = await workspace.history.commit({ ifHead: null, files })
    expect(first).toMatchObject({ files: 200, bytes: 200 * 20 * 1024 })
    expect(uploads).toHaveBeenCalledTimes(200)
    const second = await workspace.history.commit({ ifHead: first.id, files })
    expect(second.parentId).toBe(first.id)
    expect(uploads).toHaveBeenCalledTimes(200)
    expect(await workspace.history.usage()).toEqual({ bytes: 200 * 20 * 1024, objects: 200 })
  }, 30_000)
})

// Match Blob's stable result contract when injecting an operational outage.
class ViteHubBlobFailure extends ViteHubError<"BLOB_OPERATION_FAILED", { operation: "put", store: string }> {
  constructor() { super("BLOB_OPERATION_FAILED", "injected Blob failure", { details: { operation: "put", store: "test" } }) }
}

describe("history policy and capabilities", () => {
  it("reports a capability error for Stores without historical bytes", async () => {
    registerWorkspace("no-history", defineWorkspace({ store: createMemoryWorkspaceStore() }))
    const workspace = useWorkspace("no-history", { mode: "write" })
    for (const read of [() => workspace.history.head(), () => workspace.history.list(), () => workspace.history.open("missing"), () => workspace.history.usage(), () => workspace.history.commit({ ifHead: null, files: {} })]) {
      await expect(read()).rejects.toMatchObject({ code: "WORKSPACE_R0069" })
    }
    await expect(workspace.history.checkpoint()).resolves.toHaveProperty("id")
  })

  it("validates paths, size limits, validators, metadata, and deletions before upload", async () => {
    const { store, uploads } = await setup("libsql")
    const workspace = createWorkspace({ name: "rules", store, rules: { "**": { maxBytes: 4 }, "keep.txt": { write: "create" } } })
    const history = workspace.history!
    for (const path of ["../escape", ".vitehub/hidden", "nested/.git/config"]) {
      await expect(history.commit({ ifHead: null, files: { [path]: "x" } })).rejects.toMatchObject({ code: "WORKSPACE_PATH_INVALID" })
    }
    await expect(history.commit({ ifHead: null, files: { "a.txt": "large" } })).rejects.toThrow("limits writes")
    await expect(history.commit({ ifHead: null, files: {}, metadata: { nested: undefined } })).rejects.toThrow("Invalid Workspace metadata")
    expect(uploads).not.toHaveBeenCalled()
    const first = await history.commit({ ifHead: null, files: { "keep.txt": "keep" } })
    await expect(history.commit({ ifHead: first.id, files: { "keep.txt": "keep", "a.txt": "x" } })).resolves.toMatchObject({ parentId: first.id })
    const latest = await history.head()
    await expect(history.commit({ ifHead: latest!.id, files: {} })).rejects.toThrow("does not allow rm")
    expect(await history.head()).toEqual(latest)
    const transformed = createWorkspace({ name: "transformed", store, rules: { "**": { maxBytes: 4, validate: input => ({ ...input, content: "too-large" }) } } }).history!
    await expect(transformed.commit({ ifHead: latest!.id, files: { "keep.txt": "keep", "a.txt": "new" } })).rejects.toThrow("limits writes")
  })

  it("runs validators without changing stored state on rejection and rechecks Source ownership after hooks", async () => {
    const { store, uploads } = await setup("libsql")
    const transform = createWorkspace({ name: "transform", store, rules: { "**": { validate: input => ({ ...input, content: "changed" }) } } }).history!
    const first = await transform.commit({ ifHead: null, files: { "a.txt": "original" } })
    expect(await (await transform.open(first.id)).readFile("a.txt")).toBe("changed")
    const protectedHistory = createWorkspace({ name: "source", store, sources: { locked: file({ workspacePath: "locked.txt", content: "locked", materialize: "lazy" }) }, hooks: { "write:before": input => { input.path = "locked.txt" } } }).history!
    const count = uploads.mock.calls.length
    await expect(protectedHistory.commit({ ifHead: first.id, files: { "a.txt": "original" } })).rejects.toThrow("cannot rewrite")
    await expect(protectedHistory.commit({ ifHead: first.id, files: { "a.txt": "changed", "locked.txt": "owned" } })).rejects.toThrow("read-only")
    expect(uploads).toHaveBeenCalledTimes(count)
    const rejected = createWorkspace({ name: "rejected", store, rules: { "**": { validate: () => false } } }).history!
    await expect(rejected.commit({ ifHead: first.id, files: { "a.txt": "original" } })).rejects.toThrow("validator rejected")
    expect(await rejected.head()).toEqual(first)
  })

  it("guards resolved Source mounts and denies complete history to a partial scope", async () => {
    const { store, facade } = await setup("libsql")
    const definition = { name: "history", store, sources: { locked: file({ workspacePath: "locked.txt", content: "locked", materialize: "lazy" }) } }
    const invocation = { context: { entries: () => new Map<string, unknown>().entries(), get: () => undefined, has: () => false } }
    const resolved = await createWorkspaceSourceResolutionFacade(facade(), definition, { invocation, overlay: true })
    // SAFETY: The input is a writable facade, and Source resolution preserves its write operations.
    const writable = resolved.workspace as import("../src/core/use.ts").WritableWorkspaceFacade
    await expect(writable.history.commit({ ifHead: null, files: { "a/b.txt": "first", "a\\b.txt": "second" } })).rejects.toThrow("Duplicate history file path")
    await expect(writable.history.commit({ ifHead: null, files: { "locked.txt": "owned" } })).rejects.toThrow("read-only")
    const first = await writable.history.commit({ ifHead: null, files: { "a.txt": "allowed" } })
    expect(await writable.history.head()).toEqual(first)
    const second = await writable.history.commit({ ifHead: first.id, files: { "a.txt": "allowed", "b.txt": "new" } })
    expect(second).toMatchObject({ parentId: first.id })
    await expect(writable.history.commit({ ifHead: first.id, files: { "locked.txt": "owned" } })).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT", details: { expected: first.id, actual: second.id } })
    const scoped = await createWorkspaceSourceResolutionFacade(facade(), definition, { invocation, selectedWorkspaceScope: { all: false, name: "private", paths: ["a.txt"] } })
    await expect(scoped.workspace.history.head()).rejects.toMatchObject({ code: "WORKSPACE_R0069" })
    // SAFETY: The input is writable; this test verifies that its complete-history operation rejects a partial scope.
    const scopedWritable = scoped.workspace as import("../src/core/use.ts").WritableWorkspaceFacade
    await expect(scopedWritable.history.commit({ ifHead: first.id, files: {} })).rejects.toMatchObject({ code: "WORKSPACE_R0069" })
  })

  it("requires grants for the actual additions and deletions and rejects foreign grants", async () => {
    const { store } = await setup("libsql")
    const definition = { name: "grants", store }
    const view = createWorkspaceSourceView(definition, store)
    const other = createWorkspaceSourceView({ ...definition, name: "other" }, store)
    const commit = view.requireHistoryGrants(store.history)
    const options = { ifHead: null, files: rawFiles({ "a.txt": "new" }) }
    await expect(commit([], options)).rejects.toThrow("requires a Source write grant")
    await expect(commit([await view.assertWritable("b.txt")], options)).rejects.toThrow("requires a Source write grant")
    await expect(commit([await other.assertWritable("a.txt")], options)).rejects.toThrow("requires a Source write grant")
    const grant = await view.assertWritable("a.txt")
    const first = await commit([grant], options)
    await expect(commit([], { ifHead: first.id, files: {} })).rejects.toThrow("requires a Source write grant")
    expect(await store.history.head()).toEqual(first)
  })
})
