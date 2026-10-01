import { validateViteHubNitroDevRequest } from "@vite-hub/internal/dev-endpoint"
import { redactInspectionText, redactInspectionValue } from "@vite-hub/internal/inspect"
import { ViteHubError } from "@vite-hub/runtime"

import { isScheduleDevOperation, scheduleDevHeader, scheduleDevHeaderValue } from "../dev.ts"
import { schedules } from "./client.ts"
import { nextRuntimeScheduleRunAt } from "./due.ts"
import { toRunId } from "./execute.ts"
import { getRuntimeScheduleStore, getScheduleRunStore, getScheduleRuntimeRegistry, isScheduleWakeDriverActive } from "./state.ts"

import type { ViteHubConsoleRecord } from "@vite-hub/internal/console"
import type { ViteHubDefinitionField } from "@vite-hub/internal/inspect"
import type { ScheduleDevRequestBody } from "../dev.ts"
import type { RuntimeScheduleRecord, ScheduleRunAttemptRecord, ScheduleRunAttemptStatus, ScheduleRunError, ScheduleRunRecord, ScheduleRunStatus } from "../types.ts"

/** Error of a run or attempt. The stack is not included. */
export interface ScheduleRunErrorSummary {
  message: string
  name?: string
}

/** Serializable view of one Schedule Run. The response body is not included. */
export interface ScheduleRunSummary {
  attemptCount: number
  completedAt?: string
  error?: ScheduleRunErrorSummary
  id: string
  response?: { status: number, statusText: string }
  scheduleId: string
  scheduledAt: string
  startedAt?: string
  status: ScheduleRunStatus
  target: string
}

/** Serializable view of one Schedule Run attempt. */
export interface ScheduleRunAttemptSummary {
  completedAt?: string
  error?: ScheduleRunErrorSummary
  id: string
  runId: string
  startedAt: string
  status: ScheduleRunAttemptStatus
}

/** Serializable view of one Runtime Schedule. Input values that look like credentials are redacted. */
export interface RuntimeScheduleSummary {
  console: {
    /** `console.dispatch` of the record. The Console is read-only, so this value does not add a Console action. */
    dispatch: boolean
    /** `false` when the record sets `console.enabled: false`. The Console hides the record. */
    visible: boolean
  }
  createdAt: string
  cron: string
  enabled: boolean
  id: string
  input?: unknown
  lastRun?: ScheduleRunSummary
  /** Next minute that matches the cron. Absent when the Schedule is disabled or no minute matches in four years. */
  nextRunAt?: string
  target: string
  timeZone: string
  updatedAt: string
}

export interface RuntimeScheduleInspection {
  /**
   * `true` when a wake driver runs due Runtime Schedules in this runtime. When it is `false`, due times do not
   * start runs. Only `schedules.run()` starts a run.
   */
  automaticRuns: boolean
  schedules: RuntimeScheduleSummary[]
}

export interface RuntimeScheduleInspectionOptions {
  now?: Date
}

const consoleRunHistoryLimit = 10
// `toRunId("runtime", ...)` ids start with this prefix. Static Schedule runs use `srun_static_`.
const runtimeRunIdPrefix = "srun_runtime_"
const maximumInputLength = 500

function isoDate(value: Date | string | undefined): string | undefined {
  if (value === undefined) return
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

/** Redacts secret-named keys, then credentials inside each remaining string. */
function redactInput(value: unknown): unknown {
  const redacted = redactInspectionValue(value)
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate opaque inspection values or request JSON fields at the dev endpoint boundary.
  if (typeof redacted === "string") return redactInspectionText(redacted)
  if (Array.isArray(redacted)) return redacted.map(redactInput)
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate opaque inspection values or request JSON fields at the dev endpoint boundary.
  if (!redacted || typeof redacted !== "object") return redacted
  return Object.fromEntries(Object.entries(redacted).map(([key, entry]) => [key, redactInput(entry)]))
}

function summarizeError(error: ScheduleRunError | undefined): ScheduleRunErrorSummary | undefined {
  if (!error) return
  return {
    message: redactInspectionText(error.message),
    ...(error.name ? { name: redactInspectionText(error.name) } : {}),
  }
}

export function summarizeScheduleRun(run: ScheduleRunRecord): ScheduleRunSummary {
  const error = summarizeError(run.error)
  const completedAt = isoDate(run.completedAt)
  const startedAt = isoDate(run.startedAt)
  return {
    attemptCount: run.attemptCount,
    ...(completedAt ? { completedAt } : {}),
    ...(error ? { error } : {}),
    id: run.id,
    ...(run.response ? { response: { status: run.response.status, statusText: redactInspectionText(run.response.statusText) } } : {}),
    scheduleId: run.scheduleId,
    scheduledAt: isoDate(run.scheduledAt) ?? "",
    ...(startedAt ? { startedAt } : {}),
    status: run.status,
    target: run.target,
  }
}

export function summarizeScheduleRunAttempt(attempt: ScheduleRunAttemptRecord): ScheduleRunAttemptSummary {
  const error = summarizeError(attempt.error)
  const completedAt = isoDate(attempt.completedAt)
  return {
    ...(completedAt ? { completedAt } : {}),
    ...(error ? { error } : {}),
    id: attempt.id,
    runId: attempt.runId,
    startedAt: isoDate(attempt.startedAt) ?? "",
    status: attempt.status,
  }
}

/** Returns true for a run that `schedules.run()` or a wake driver started for the Runtime Schedule `id`. */
function isRuntimeScheduleRun(run: ScheduleRunRecord, id: string): boolean {
  return run.scheduleId === id && run.id.startsWith(runtimeRunIdPrefix)
}

function newestFirst(left: ScheduleRunRecord, right: ScheduleRunRecord): number {
  return new Date(right.scheduledAt).getTime() - new Date(left.scheduledAt).getTime()
}

function nextRunAt(schedule: RuntimeScheduleRecord, now: Date): string | undefined {
  if (!schedule.enabled) return
  try {
    return nextRuntimeScheduleRunAt(schedule, now)?.toISOString()
  }
  catch {
    // A stored record with an invalid cron or time zone has no next run. The record stays inspectable.
    return undefined
  }
}

export function summarizeRuntimeSchedule(
  schedule: RuntimeScheduleRecord,
  runs: readonly ScheduleRunRecord[],
  now: Date = new Date(),
): RuntimeScheduleSummary {
  const lastRun = runs.filter(run => isRuntimeScheduleRun(run, schedule.id)).sort(newestFirst)[0]
  const next = nextRunAt(schedule, now)
  return {
    console: {
      dispatch: schedule.console?.dispatch === true,
      visible: schedule.console?.enabled !== false,
    },
    createdAt: isoDate(schedule.createdAt) ?? "",
    cron: schedule.cron,
    enabled: schedule.enabled,
    id: schedule.id,
    ...(schedule.input !== undefined ? { input: redactInput(schedule.input) } : {}),
    ...(lastRun ? { lastRun: summarizeScheduleRun(lastRun) } : {}),
    ...(next ? { nextRunAt: next } : {}),
    target: schedule.target,
    timeZone: schedule.timeZone ?? "UTC",
    updatedAt: isoDate(schedule.updatedAt) ?? "",
  }
}

interface RuntimeScheduleState {
  runs: Map<string, ScheduleRunRecord[]>
  schedules: RuntimeScheduleRecord[]
}

async function readRuntimeScheduleState(limit: number, visibleOnly = false): Promise<RuntimeScheduleState> {
  const records = (await getRuntimeScheduleStore().list()).filter(schedule => !visibleOnly || schedule.console?.enabled !== false)
  const runs = new Map<string, ScheduleRunRecord[]>()
  const store = getScheduleRunStore()
  const queries = records.map(schedule => ({ scheduleId: schedule.id, runtimeOnly: true, limit }))
  const histories = store.listRunsBatch
    ? await store.listRunsBatch(queries)
    : await Promise.all(queries.map(query => store.listRuns(query)))
  for (const [index, schedule] of records.entries()) runs.set(schedule.id, histories[index] ?? [])
  return { runs, schedules: [...records].sort((left, right) => left.id.localeCompare(right.id)) }
}

/** Lists Runtime Schedules of this runtime with their next due time and last run. */
export async function inspectRuntimeSchedules(options: RuntimeScheduleInspectionOptions = {}): Promise<RuntimeScheduleInspection> {
  const now = options.now ?? new Date()
  const state = await readRuntimeScheduleState(1)
  return {
    automaticRuns: isScheduleWakeDriverActive(),
    schedules: state.schedules.map(schedule => summarizeRuntimeSchedule(schedule, state.runs.get(schedule.id) ?? [], now)),
  }
}

/** Returns one Runtime Schedule, or `undefined` when the store has no record with this id. */
export async function inspectRuntimeSchedule(id: string, options: RuntimeScheduleInspectionOptions = {}): Promise<RuntimeScheduleSummary | undefined> {
  const schedule = await getRuntimeScheduleStore().get(id)
  if (!schedule) return
  return summarizeRuntimeSchedule(schedule, await getScheduleRunStore().listRuns({ scheduleId: id, runtimeOnly: true, limit: 1 }), options.now)
}

/**
 * Lists the runs of one Schedule id, newest first. The list includes Runtime Schedule runs and runs of a static
 * Schedule Definition with the same name.
 */
export async function listRuntimeScheduleRuns(scheduleId: string, options: { limit?: number } = {}): Promise<ScheduleRunSummary[]> {
  const runs = (await getScheduleRunStore().listRuns({ scheduleId, limit: options.limit }))
    .filter(run => run.scheduleId === scheduleId)
    .sort(newestFirst)
  return (options.limit === undefined ? runs : runs.slice(0, options.limit)).map(summarizeScheduleRun)
}

/** Lists the attempts of one Schedule Run, oldest first. */
export async function listScheduleRunAttempts(runId: string): Promise<ScheduleRunAttemptSummary[]> {
  const attempts = await getScheduleRunStore().listAttempts(runId)
  return [...attempts]
    .sort((left, right) => new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime())
    .map(summarizeScheduleRunAttempt)
}

function formatInput(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > maximumInputLength ? `${text.slice(0, maximumInputLength)}...` : text
}

function formatRun(run: ScheduleRunSummary): string {
  const attempts = `${run.attemptCount} attempt${run.attemptCount === 1 ? "" : "s"}`
  return [run.scheduledAt, run.status, attempts, ...(run.error ? [run.error.message] : []), run.id].join(", ")
}

function consoleRecord(summary: RuntimeScheduleSummary, runs: readonly ScheduleRunSummary[], automaticRuns: boolean): ViteHubConsoleRecord {
  const next = summary.enabled
    ? summary.nextRunAt
      ? `${summary.nextRunAt}${automaticRuns ? "" : " (not automatic)"}`
      : "None in 4 years"
    : "Disabled"
  const fields: ViteHubDefinitionField[] = [
    { label: "Target", value: summary.target },
    { label: "Cron", value: summary.cron },
    { label: "Time zone", value: summary.timeZone },
    { label: "State", value: summary.enabled ? "Enabled" : "Disabled" },
    { label: "Next due time", value: next },
    {
      label: "Automatic runs",
      value: automaticRuns
        ? "A wake driver runs due Schedules in this runtime."
        : "No wake driver is installed. Due times do not start runs in this runtime.",
    },
    {
      label: "Console dispatch",
      value: summary.console.dispatch
        ? "Allowed by the record. The Console is read-only. Use `vitehub schedule run` in development."
        : "Not allowed by the record.",
    },
    ...(summary.input !== undefined ? [{ label: "Input", value: formatInput(summary.input) }] : []),
    { label: "Created", value: summary.createdAt },
    { label: "Updated", value: summary.updatedAt },
  ]
  if (runs.length === 0) {
    fields.push({ label: "Run history", value: "No runs." })
  }
  runs.slice(0, consoleRunHistoryLimit).forEach((run, index) => {
    fields.push({ label: `Run ${index + 1}`, value: formatRun(run) })
  })
  if (runs.length >= consoleRunHistoryLimit) {
    fields.push({ label: "Older runs", value: `Use \`vitehub schedule runs ${summary.id}\`.` })
  }
  return {
    cells: {
      enabled: summary.enabled ? "Enabled" : "Disabled",
      kind: "Runtime",
      lastRun: summary.lastRun ? `${summary.lastRun.status} at ${summary.lastRun.scheduledAt}` : "No runs",
      nextRun: next,
      schedule: summary.id,
      target: summary.target,
      timing: summary.timeZone === "UTC" ? summary.cron : `${summary.cron} (${summary.timeZone})`,
    },
    fields,
    id: `runtime:${summary.id}`,
  }
}

/**
 * Console runtime reader. Returns one record for each Runtime Schedule that does not set `console.enabled: false`.
 * The Console calls it on each request.
 */
export async function readScheduleConsoleRecords(): Promise<ViteHubConsoleRecord[]> {
  const now = new Date()
  const state = await readRuntimeScheduleState(consoleRunHistoryLimit, true)
  const automaticRuns = isScheduleWakeDriverActive()
  return state.schedules
    .map(schedule => summarizeRuntimeSchedule(schedule, state.runs.get(schedule.id) ?? [], now))
    .filter(summary => summary.console.visible)
    .map(summary => consoleRecord(
      summary,
      (state.runs.get(summary.id) ?? []).filter(run => isRuntimeScheduleRun(run, summary.id)).sort(newestFirst).map(summarizeScheduleRun),
      automaticRuns,
    ))
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { headers: { "cache-control": "no-store" }, status })
}

function failure(message: string, status: number, code?: string): Response {
  return json({ error: { ...(code ? { code } : {}), message } }, status)
}

const errorStatus: Readonly<Record<string, number>> = {
  SCHEDULE_DISABLED: 409,
  SCHEDULE_NOT_FOUND: 404,
  SCHEDULE_RUN_NOT_FOUND: 404,
  SCHEDULE_TARGET_NOT_ELIGIBLE: 409,
  SCHEDULE_TARGET_NOT_FOUND: 409,
}

function scheduleFailure(error: unknown): Response {
  if (!(error instanceof ViteHubError)) {
    return failure("The Schedule operation failed.", 500)
  }
  if (error.code === "SCHEDULE_TARGET_NOT_FOUND" && !getScheduleRuntimeRegistry()) {
    return failure(
      "No Schedule registry is installed in this runtime, so it cannot load the target. Configure `runtime: { driver: 'process' }` or install the registry with `setScheduleRuntimeRegistry()`.",
      409,
      error.code,
    )
  }
  return failure(redactInspectionText(error.message), errorStatus[error.code] ?? 400, error.code)
}

async function readBody(request: Request): Promise<ScheduleDevRequestBody | undefined> {
  const body: unknown = await request.json().catch(() => undefined)
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate opaque inspection values or request JSON fields at the dev endpoint boundary.
  if (!body || typeof body !== "object" || Array.isArray(body)) return
  const operation: unknown = Reflect.get(body, "operation")
  const id: unknown = Reflect.get(body, "id")
  const limit: unknown = Reflect.get(body, "limit")
  if (!isScheduleDevOperation(operation)) return
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate opaque inspection values or request JSON fields at the dev endpoint boundary.
  if (id !== undefined && (typeof id !== "string" || !id)) return
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate opaque inspection values or request JSON fields at the dev endpoint boundary.
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) return
  return {
    ...(id !== undefined ? { id } : {}),
    ...(limit !== undefined ? { limit } : {}),
    operation,
  }
}

async function runOperation(body: ScheduleDevRequestBody): Promise<Response> {
  if (body.operation === "list") {
    return json(await inspectRuntimeSchedules())
  }
  const id = body.id
  if (!id) return failure(`The ${body.operation} operation requires an id.`, 400)
  switch (body.operation) {
    case "get": {
      const schedule = await inspectRuntimeSchedule(id)
      return schedule
        ? json({ automaticRuns: isScheduleWakeDriverActive(), schedule })
        : failure("Runtime Schedule was not found.", 404, "SCHEDULE_NOT_FOUND")
    }
    case "runs":
      return json({ runs: await listRuntimeScheduleRuns(id, { limit: body.limit }) })
    case "attempts": {
      const run = await getScheduleRunStore().getRun(id)
      if (!run) return failure("Schedule Run was not found.", 404, "SCHEDULE_RUN_NOT_FOUND")
      return json({ attempts: await listScheduleRunAttempts(id), run: summarizeScheduleRun(run) })
    }
    case "run": {
      const scheduledAt = new Date()
      try {
        return json({ run: summarizeScheduleRun(await schedules.run(id, { scheduledAt })) })
      }
      catch (error) {
        // The handler failed after the run started. Return the stored failed run.
        const run = await getScheduleRunStore().getRun(toRunId("runtime", id, scheduledAt))
        return run?.status === "failed" ? json({ run: summarizeScheduleRun(run) }) : scheduleFailure(error)
      }
    }
    case "enable":
    case "disable":
      try {
        const updated = body.operation === "enable" ? await schedules.enable(id) : await schedules.disable(id)
        let runs: ScheduleRunRecord[] = []
        try {
          runs = await getScheduleRunStore().listRuns({ scheduleId: id, runtimeOnly: true, limit: 1 })
        }
        catch {
          // History is optional after the Schedule mutation has persisted.
        }
        return json({ schedule: summarizeRuntimeSchedule(updated, runs) })
      }
      catch (error) {
        return scheduleFailure(error)
      }
  }
}

/**
 * Handles one Schedule operation from `vitehub schedule`. The Vite Development Server forwards the request into the
 * Nitro runtime, so the operation uses the same stores and registry as the application.
 *
 * The request must carry the Schedule dev header, must not come from another origin, and must use JSON.
 * The owner authorization callback is required. The Node dev entry supplies private project-token verification.
 */
export async function handleScheduleDevRequest(request: Request, options: { authorize?: (request: Request) => Promise<boolean> } = {}): Promise<Response> {
  const rejection = validateViteHubNitroDevRequest(request, { header: scheduleDevHeader, headerValue: scheduleDevHeaderValue, label: "Schedule Dev" })
  if (rejection) return rejection
  if (!await options.authorize?.(request)) return new Response("Forbidden Schedule Dev token.", { status: 403 })
  const body = await readBody(request)
  if (!body) return failure("The Schedule Dev request body is invalid.", 400)
  try {
    return await runOperation(body)
  }
  catch (error) {
    return scheduleFailure(error)
  }
}
