import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createViteHubDevToken, removeViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"

import { scheduleDevHeader, scheduleDevHeaderValue, scheduleDevTokenNamespace, scheduleDevTokenServerHeader } from "../src/dev.ts"
import { defineScheduleTarget, schedules } from "../src/index.ts"
import {
  inspectRuntimeSchedules,
  listRuntimeScheduleRuns,
  readScheduleConsoleRecords,
} from "../src/runtime/console.ts"
import type { RuntimeScheduleSummary, ScheduleRunAttemptSummary, ScheduleRunSummary } from "../src/runtime/console.ts"
import type { RuntimeScheduleRecord } from "../src/types.ts"
import { createMemoryScheduleRunStore } from "../src/runtime/store.ts"
import { handleScheduleDevRequest as handleAuthenticatedScheduleDevRequest } from "../src/runtime/dev.ts"
import { nextRuntimeScheduleRunAt } from "../src/runtime/due.ts"
import { resetScheduleRuntime, setScheduleRunStore, setScheduleRuntimeRegistry, setScheduleWakeDriverActive } from "../src/runtime/state.ts"

let credential: { serverId: string, token: string }

function handleScheduleDevRequest(request: Request) {
  return handleAuthenticatedScheduleDevRequest(request, { rootDir: process.cwd(), serverId: credential.serverId })
}

beforeEach(async () => { credential = await createViteHubDevToken(process.cwd(), scheduleDevTokenNamespace) })

const now = new Date("2026-05-23T08:15:00.000Z")

interface DevResponseBody {
  attempts?: ScheduleRunAttemptSummary[]
  error?: { code?: string, message: string }
  run?: ScheduleRunSummary
  schedule?: RuntimeScheduleSummary
}

async function readBody(response: Response): Promise<DevResponseBody> {
  return await response.json() as DevResponseBody
}

function scheduleRecord(cron: string, timeZone?: string): RuntimeScheduleRecord {
  return { createdAt: now, cron, enabled: true, id: "digest", target: "report", ...(timeZone ? { timeZone } : {}), updatedAt: now }
}

function devRequest(body: unknown, init: { headers?: Record<string, string>, method?: string } = {}): Request {
  const method = init.method ?? "POST"
  return new Request("http://localhost/_vitehub/schedule/dev", {
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", [scheduleDevHeader]: scheduleDevHeaderValue, [viteHubDevTokenHeader]: credential.token, [scheduleDevTokenServerHeader]: credential.serverId, ...init.headers },
    method,
  })
}

function installTargets(handler: (input: unknown) => void = () => {}): void {
  setScheduleRuntimeRegistry({
    report: async () => defineScheduleTarget<{ prompt?: string, token?: string }>({
      handler: async context => handler(context.input),
    }),
  })
}

afterEach(async () => {
  await removeViteHubDevToken(process.cwd(), { namespace: scheduleDevTokenNamespace, serverId: credential.serverId })
  resetScheduleRuntime()
})

describe("Runtime Schedule inspection", () => {
  it("finds the next due minute in the Schedule time zone", () => {
    expect(nextRuntimeScheduleRunAt(scheduleRecord("30 9 * * *", "Europe/Copenhagen"), now)?.toISOString()).toBe("2026-05-24T07:30:00.000Z")
    expect(nextRuntimeScheduleRunAt(scheduleRecord("0 9 * * *"), now)?.toISOString()).toBe("2026-05-23T09:00:00.000Z")
    expect(nextRuntimeScheduleRunAt(scheduleRecord("0 0 30 2 *"), now)).toBeUndefined()
  })

  it("finds the first occurrence through the Chatham DST fallback", () => {
    expect(nextRuntimeScheduleRunAt(scheduleRecord("45 2 * * *", "Pacific/Chatham"), new Date("2026-04-04T13:45:00.000Z"))?.toISOString())
      .toBe("2026-04-04T14:00:00.000Z")
  })

  it("caches sparse next occurrences between inspection requests", () => {
    const format = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts")
    const schedule = scheduleRecord("0 0 29 2 *", "Pacific/Chatham")
    const after = new Date("2026-07-01T00:00:00.000Z")
    const first = nextRuntimeScheduleRunAt(schedule, after)
    const reads = format.mock.calls.length
    expect(first).toBeDefined()
    expect(nextRuntimeScheduleRunAt(schedule, new Date(after.getTime() + 60_000))).toEqual(first)
    expect(format).toHaveBeenCalledTimes(reads)
    format.mockRestore()
  })

  it("inspects opaque input and separates Runtime and Definition IDs", async () => {
    installTargets()
    const input: Record<string, unknown> = { count: 1n }
    input.self = input
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "definition:daily", target: "report", input })
    const inspection = await inspectRuntimeSchedules({ now })
    expect(inspection.schedules[0]?.input).toEqual({ count: "1", self: "[circular]" })
    expect(() => JSON.stringify(inspection)).not.toThrow()
    expect((await readScheduleConsoleRecords())[0]?.id).toBe("runtime:definition:daily")
  })

  it.each(["enable", "disable"])("preserves %s success when optional history is unavailable", async (operation) => {
    installTargets()
    await schedules.dynamic.create({ cron: "0 9 * * *", enabled: operation === "disable", id: "digest", target: "report" })
    setScheduleRunStore({ ...createMemoryScheduleRunStore(), listRuns: () => { throw new Error("history unavailable") } })
    const response = await handleScheduleDevRequest(devRequest({ operation, id: "digest" }))
    expect(response.status).toBe(200)
    const body = await readBody(response)
    expect(body.schedule).toMatchObject({ id: "digest", enabled: operation === "enable" })
    expect(body.schedule?.lastRun).toBeUndefined()
    expect((await schedules.get("digest"))?.enabled).toBe(operation === "enable")
  })

  it("reports persistence failures after the run record was created", async () => {
    installTargets()
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", target: "report" })
    setScheduleRunStore({ ...createMemoryScheduleRunStore(), createAttempt: () => { throw new Error("attempt storage failed") } })
    const response = await handleScheduleDevRequest(devRequest({ operation: "run", id: "digest" }))
    expect(response.status).toBe(500)
    expect(await readBody(response)).toHaveProperty("error")
  })

  it("lists Runtime Schedules with next run, last run, and redacted input", async () => {
    installTargets()
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", input: { prompt: "Read https://bot:pw-secret@example.test/feed", token: "sk-live-secret" }, target: "report" })
    await schedules.dynamic.create({ cron: "0 10 * * *", enabled: false, id: "paused", target: "report" })
    await schedules.run("digest", { scheduledAt: new Date("2026-05-22T09:00:00.000Z") })

    const inspection = await inspectRuntimeSchedules({ now })

    expect(inspection.automaticRuns).toBe(false)
    expect(inspection.schedules.map(schedule => schedule.id)).toEqual(["digest", "paused"])
    expect(inspection.schedules[0]).toMatchObject({
      console: { dispatch: false, visible: true },
      cron: "0 9 * * *",
      enabled: true,
      input: { prompt: "Read https://[redacted]@example.test/feed", token: "[redacted]" },
      lastRun: { id: "srun_runtime_digest_2026-05-22T09:00:00.000Z", status: "succeeded" },
      nextRunAt: "2026-05-23T09:00:00.000Z",
      target: "report",
      timeZone: "UTC",
    })
    expect(inspection.schedules[1]).not.toHaveProperty("nextRunAt")
    expect(JSON.stringify(inspection)).not.toMatch(/sk-live-secret|pw-secret/)
  })

  it("lists runs newest first with a limit and redacts error messages", async () => {
    installTargets(() => {
      throw new Error("Request to https://user:hunter2@example.test failed")
    })
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", target: "report" })
    await schedules.run("digest", { scheduledAt: new Date("2026-05-21T09:00:00.000Z") }).catch(() => {})
    await schedules.run("digest", { scheduledAt: new Date("2026-05-22T09:00:00.000Z") }).catch(() => {})

    const runs = await listRuntimeScheduleRuns("digest", { limit: 1 })

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ scheduledAt: "2026-05-22T09:00:00.000Z", status: "failed" })
    expect(runs[0]?.error?.message).not.toContain("hunter2")
  })

  it.each([
    ["proxy_authorization=Basic dXNlcjpwYXNz", "proxy_authorization=[redacted]"],
    ["request_cookie=theme=dark; sessionid=abc123", "request_cookie=[redacted]"],
  ])("redacts classified compound credentials in run failures: %s", async (message, redacted) => {
    installTargets(() => {
      throw new Error(message)
    })
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", target: "report" })
    await schedules.run("digest").catch(() => {})
    const runs = await listRuntimeScheduleRuns("digest")
    expect(runs[0]?.error?.message).toBe(redacted)
  })

  it("queries only visible Console records with the history limit", async () => {
    installTargets()
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "visible", target: "report" })
    await schedules.dynamic.create({ console: { enabled: false }, cron: "0 9 * * *", id: "hidden", target: "report" })
    const store = createMemoryScheduleRunStore()
    const listRuns = vi.fn(store.listRuns)
    setScheduleRunStore({ ...store, listRuns })
    await readScheduleConsoleRecords()
    expect(listRuns.mock.calls).toEqual([[{ scheduleId: "visible", runtimeOnly: true, limit: 10 }]])
  })

  it("batches visible Console histories through the optional store method", async () => {
    installTargets()
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "alpha", target: "report" })
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "beta", target: "report" })
    await schedules.dynamic.create({ console: { enabled: false }, cron: "0 9 * * *", id: "hidden", target: "report" })
    const store = createMemoryScheduleRunStore()
    const listRuns = vi.fn(store.listRuns)
    const listRunsBatch = vi.fn(async () => [[], []])
    setScheduleRunStore({ ...store, listRuns, listRunsBatch })
    await readScheduleConsoleRecords()
    expect(listRuns).not.toHaveBeenCalled()
    expect(listRunsBatch.mock.calls).toEqual([[[
      { scheduleId: "alpha", runtimeOnly: true, limit: 10 },
      { scheduleId: "beta", runtimeOnly: true, limit: 10 },
    ]]])
  })

  it("reads Console records with run history and hides records that opt out", async () => {
    installTargets()
    setScheduleWakeDriverActive(true)
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", target: "report", timeZone: "Europe/Copenhagen" })
    await schedules.dynamic.create({ console: { enabled: false }, cron: "0 9 * * *", id: "hidden", target: "report" })
    await schedules.run("digest", { scheduledAt: new Date("2026-05-22T07:00:00.000Z") })

    const records = await readScheduleConsoleRecords()

    expect(records.map(record => record.id)).toEqual(["runtime:digest"])
    expect(records[0]?.cells).toMatchObject({
      enabled: "Enabled",
      kind: "Runtime",
      lastRun: "succeeded at 2026-05-22T07:00:00.000Z",
      schedule: "digest",
      target: "report",
      timing: "0 9 * * * (Europe/Copenhagen)",
    })
    expect(records[0]?.cells.nextRun).not.toContain("not automatic")
    expect(records[0]?.fields).toContainEqual({
      label: "Run 1",
      value: "2026-05-22T07:00:00.000Z, succeeded, 1 attempt, srun_runtime_digest_2026-05-22T07:00:00.000Z",
    })

    setScheduleWakeDriverActive(false)
    expect((await readScheduleConsoleRecords())[0]?.cells.nextRun).toMatch(/\(not automatic\)$/)
  })
})

describe("Schedule dev request handler", () => {
  it("rejects another instance credential at the replacement server handler", async () => {
    const previous = credential
    const replacement = await createViteHubDevToken(process.cwd(), scheduleDevTokenNamespace)
    try {
      const request = devRequest({ operation: "list" }, {
        headers: {
          [viteHubDevTokenHeader]: previous.token,
          [scheduleDevTokenServerHeader]: previous.serverId,
        },
      })
      expect((await handleAuthenticatedScheduleDevRequest(request, {
        rootDir: process.cwd(), serverId: replacement.serverId,
      })).status).toBe(403)
      expect((await handleScheduleDevRequest(request)).status).toBe(200)
    }
    finally {
      await removeViteHubDevToken(process.cwd(), { namespace: scheduleDevTokenNamespace, serverId: replacement.serverId })
    }
  })

  it("rejects requests without the guard, from other origins, with other methods, or without JSON", async () => {
    const missingHeader = new Request("http://localhost/_vitehub/schedule/dev", {
      body: JSON.stringify({ operation: "list" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect((await handleScheduleDevRequest(missingHeader)).status).toBe(403)
    expect((await handleScheduleDevRequest(devRequest({ operation: "list" }, { headers: { origin: "https://attacker.test" } }))).status).toBe(403)
    expect((await handleScheduleDevRequest(devRequest(undefined, { method: "GET" }))).status).toBe(405)
    expect((await handleScheduleDevRequest(devRequest({ operation: "list" }, { headers: { "content-type": "text/plain" } }))).status).toBe(415)
    expect((await handleScheduleDevRequest(devRequest("{"))).status).toBe(400)
    expect((await handleScheduleDevRequest(devRequest({ operation: "delete", id: "digest" }))).status).toBe(400)
    expect((await handleScheduleDevRequest(devRequest({ limit: 0, operation: "runs", id: "digest" }))).status).toBe(400)
  })

  it.each(["run", "enable", "disable"])("rejects public-header-only %s mutations before changing state", async operation => {
    const handler = vi.fn()
    installTargets(handler)
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", target: "report" })
    const request = new Request("http://192.0.2.1/_vitehub/schedule/dev", {
      method: "POST", body: JSON.stringify({ id: "digest", operation }),
      headers: { "content-type": "application/json", [scheduleDevHeader]: scheduleDevHeaderValue },
    })
    expect((await handleScheduleDevRequest(request)).status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
    expect((await schedules.get("digest"))?.enabled).toBe(true)
  })

  it("runs, disables, and enables a Runtime Schedule", async () => {
    installTargets()
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", target: "report" })

    const run = await handleScheduleDevRequest(devRequest({ id: "digest", operation: "run" }))
    expect(run.status).toBe(200)
    expect(run.headers.get("cache-control")).toBe("no-store")
    const { run: summary } = await readBody(run)
    expect(summary).toMatchObject({ attemptCount: 1, scheduleId: "digest", status: "succeeded" })
    const runId = summary?.id

    const attempts = await readBody(await handleScheduleDevRequest(devRequest({ id: runId, operation: "attempts" })))
    expect(attempts).toMatchObject({ attempts: [{ runId, status: "succeeded" }], run: { id: runId } })

    const disabled = await readBody(await handleScheduleDevRequest(devRequest({ id: "digest", operation: "disable" })))
    expect(disabled.schedule).toMatchObject({ enabled: false, id: "digest" })
    expect(disabled.schedule).not.toHaveProperty("nextRunAt")
    const blocked = await handleScheduleDevRequest(devRequest({ id: "digest", operation: "run" }))
    expect(blocked.status).toBe(409)
    expect(await readBody(blocked)).toMatchObject({ error: { code: "SCHEDULE_DISABLED" } })

    const enabled = await readBody(await handleScheduleDevRequest(devRequest({ id: "digest", operation: "enable" })))
    expect(enabled.schedule).toMatchObject({ enabled: true, id: "digest", nextRunAt: expect.any(String) })
  })

  it("returns the stored failed run when the handler fails", async () => {
    installTargets(() => {
      throw new Error("Bearer abc.def.ghi rejected")
    })
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", target: "report" })

    const response = await handleScheduleDevRequest(devRequest({ id: "digest", operation: "run" }))

    expect(response.status).toBe(200)
    const body = await readBody(response)
    expect(body.run).toMatchObject({ scheduleId: "digest", status: "failed" })
    expect(JSON.stringify(body)).not.toContain("abc.def.ghi")
  })

  it.each(["Error", "Authorization: Bearer error-name-secret"])("redacts stored run and attempt error names: %s", async (name) => {
    installTargets(() => {
      const error = new Error("Target failed")
      error.name = name
      throw error
    })
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", target: "report" })
    const response = await handleScheduleDevRequest(devRequest({ id: "digest", operation: "run" }))
    expect(response.status).toBe(200)
    const body = await readBody(response)
    const expectedName = name === "Error" ? name : "Authorization: [redacted]"
    expect(body.run?.error).toEqual({ message: "Target failed", name: expectedName })
    const attempts = await readBody(await handleScheduleDevRequest(devRequest({ id: body.run?.id, operation: "attempts" })))
    expect(attempts.run?.error?.name).toBe(expectedName)
    expect(attempts.attempts?.[0]?.error?.name).toBe(expectedName)
    expect(JSON.stringify({ body, attempts })).not.toContain("error-name-secret")
  })

  it("redacts stored response status text at the dev API boundary", async () => {
    const store = createMemoryScheduleRunStore()
    const id = "srun_runtime_digest_response"
    await store.createRun({ id, scheduleId: "digest", target: "report", scheduledAt: now, createdAt: now, updatedAt: now,
      status: "succeeded", attemptCount: 1, response: { body: { data: "", encoding: "base64", mediaType: "text/plain" }, headers: [], status: 200, statusText: "Authorization: Bearer status-secret" } })
    setScheduleRunStore(store)
    const response = await handleScheduleDevRequest(devRequest({ id, operation: "attempts" }))
    expect(response.status).toBe(200)
    const body = await readBody(response)
    expect(body.run?.response).toMatchObject({ status: 200, statusText: "Authorization: [redacted]" })
    expect(JSON.stringify(body)).not.toContain("status-secret")
  })

  it("reports missing records and a missing registry", async () => {
    expect(await readBody(await handleScheduleDevRequest(devRequest({ id: "missing", operation: "get" })))).toMatchObject({
      error: { code: "SCHEDULE_NOT_FOUND" },
    })
    expect((await handleScheduleDevRequest(devRequest({ id: "srun_missing", operation: "attempts" }))).status).toBe(404)
    expect((await handleScheduleDevRequest(devRequest({ operation: "get" }))).status).toBe(400)

    installTargets()
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", target: "report" })
    setScheduleRuntimeRegistry(undefined)
    const response = await handleScheduleDevRequest(devRequest({ id: "digest", operation: "run" }))
    expect(response.status).toBe(409)
    expect((await readBody(response)).error?.message).toContain("No Schedule registry is installed")
  })
})
