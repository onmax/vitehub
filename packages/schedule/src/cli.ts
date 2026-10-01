import {
  discoverViteHubDevServer,
  fetchViteHubDevEndpoint,
  readViteHubDevTargetOption,
  resolveViteHubDevServerUrl,
} from "@vite-hub/internal/cli"

import { scheduleDevHeader, scheduleDevHeaderValue, scheduleDevRoute } from "./dev.ts"
import { scheduleErrorDiagnostics } from "./error-diagnostics.ts"

import type { ViteHubCliContext, ViteHubCliContributor, ViteHubCliStreams } from "@vite-hub/internal/cli"
import type { ScheduleDevOperation, ScheduleDevRequestBody } from "./dev.ts"
import type {
  RuntimeScheduleInspection,
  RuntimeScheduleSummary,
  ScheduleRunAttemptSummary,
  ScheduleRunSummary,
} from "./runtime/console.ts"

export type ScheduleCliContext = Pick<ViteHubCliContext, "cwd" | "env" | "rootDir"> & ViteHubCliStreams

export interface ScheduleCliOptions {
  fetch?: typeof fetch
}

interface ScheduleCommand {
  description: string
  id?: "schedule" | "run"
  limit?: boolean
  name: ScheduleDevOperation
}

interface ParsedScheduleArgs {
  help: boolean
  id?: string
  json: boolean
  limit?: number
  timeout?: number
  url: string
}

const scheduleDevEndpoint = {
  header: scheduleDevHeader,
  headerValue: scheduleDevHeaderValue,
  route: scheduleDevRoute,
}

const scheduleDevTargetErrors = {
  invalidInlineTimeout: (message: string) => scheduleErrorDiagnostics.SCHEDULE_R0038({ message }),
  invalidTimeout: (message: string) => scheduleErrorDiagnostics.SCHEDULE_R0037({ message }),
  missingValue: (message: string) => scheduleErrorDiagnostics.SCHEDULE_R0036({ message }),
}

// Nuxt mounts Vite under `/_nuxt/`, so the Schedule dev endpoint is not reachable there.
const scheduleDevServerHint = "`vitehub schedule` needs a running Vite + Nitro Development Server with `schedule` enabled. Nuxt and plain Vite are not supported."

const scheduleCommands: readonly ScheduleCommand[] = [
  { description: "List Runtime Schedules with next due time and last run.", name: "list" },
  { description: "Show one Runtime Schedule.", id: "schedule", name: "get" },
  { description: "List the runs of one Runtime Schedule, newest first.", id: "schedule", limit: true, name: "runs" },
  { description: "List the attempts of one Schedule Run.", id: "run", name: "attempts" },
  { description: "Run one Runtime Schedule now.", id: "schedule", name: "run" },
  { description: "Enable one Runtime Schedule.", id: "schedule", name: "enable" },
  { description: "Disable one Runtime Schedule.", id: "schedule", name: "disable" },
]

function commandUsage(command: ScheduleCommand): string {
  const id = command.id === "run" ? " <runId>" : command.id ? " <id>" : ""
  return `vitehub schedule ${command.name}${id}${command.limit ? " [--limit <n>]" : ""} [--json] [--url <url>]`
}

function writeUsage(command: ScheduleCommand, stream: ViteHubCliStreams["stdout"]): void {
  stream.write([
    `Usage: ${commandUsage(command)}`,
    "",
    command.description,
    "The command calls the Schedule runtime of a running Vite + Nitro Development Server.",
    "",
    "Options:",
    ...(command.limit ? ["  --limit <n>       Show at most n runs."] : []),
    "  --json            Print JSON.",
    "  --url <url>       Compatible Vite Development Server URL. Defaults to http://localhost:5173.",
    "  --timeout <ms>    Request timeout.",
    "  -h, --help        Show this help.",
    "  --                End options before an ID that starts with a hyphen.",
    "",
  ].join("\n"))
}

function parseLimit(value: string | undefined): number {
  const limit = Number(value)
  if (!value || !Number.isInteger(limit) || limit < 1) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0036({ message: "--limit must be a positive integer." })
  }
  return limit
}

function parseArgs(command: ScheduleCommand, args: readonly string[], env: NodeJS.ProcessEnv): ParsedScheduleArgs {
  const parsed: ParsedScheduleArgs = { help: false, json: false, url: resolveViteHubDevServerUrl(env) }
  let positionalOnly = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (!positionalOnly && arg === "--") {
      positionalOnly = true
      continue
    }
    if (positionalOnly) {
      if (command.id && parsed.id === undefined) {
        parsed.id = arg
        continue
      }
      throw scheduleErrorDiagnostics.SCHEDULE_R0036({ message: `Unexpected argument: ${arg}.` })
    }
    if (arg === "-h" || arg === "--help") {
      parsed.help = true
      continue
    }
    if (arg === "--json") {
      parsed.json = true
      continue
    }
    const targetOption = readViteHubDevTargetOption(args, index, parsed, scheduleDevTargetErrors)
    if (targetOption !== undefined) {
      index += targetOption
      continue
    }
    if (command.limit && arg === "--limit") {
      parsed.limit = parseLimit(args[index + 1])
      index += 1
      continue
    }
    if (command.limit && arg.startsWith("--limit=")) {
      parsed.limit = parseLimit(arg.slice("--limit=".length))
      continue
    }
    if (arg.startsWith("-")) throw scheduleErrorDiagnostics.SCHEDULE_R0036({ message: `Unknown option: ${arg}.` })
    if (command.id && parsed.id === undefined) {
      parsed.id = arg
      continue
    }
    throw scheduleErrorDiagnostics.SCHEDULE_R0036({ message: `Unexpected argument: ${arg}.` })
  }
  if (!parsed.help && command.id && !parsed.id) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0036({ message: `Missing ${command.id === "run" ? "Schedule Run" : "Schedule"} id.` })
  }
  return parsed
}

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  return rows.map(row => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  ")).join("\n")
}

function runLabel(run: ScheduleRunSummary | undefined): string {
  return run ? `${run.status} ${run.scheduledAt}` : "-"
}

function automaticRunsNotice(automaticRuns: boolean): string {
  return automaticRuns
    ? "Automatic runs: on. A wake driver runs due Schedules in this runtime."
    : "Automatic runs: off. No wake driver is installed, so due times do not start runs in this runtime."
}

function formatScheduleList(result: RuntimeScheduleInspection): string {
  if (result.schedules.length === 0) return `No Runtime Schedules.\n${automaticRunsNotice(result.automaticRuns)}\n`
  return `${table([
    ["ID", "TARGET", "CRON", "ENABLED", "NEXT RUN", "LAST RUN"],
    ...result.schedules.map(schedule => [
      schedule.id,
      schedule.target,
      schedule.timeZone === "UTC" ? schedule.cron : `${schedule.cron} (${schedule.timeZone})`,
      schedule.enabled ? "yes" : "no",
      schedule.nextRunAt ?? "-",
      runLabel(schedule.lastRun),
    ]),
  ])}\n${automaticRunsNotice(result.automaticRuns)}\n`
}

function formatSchedule(schedule: RuntimeScheduleSummary, automaticRuns?: boolean): string {
  return [
    `Schedule: ${schedule.id}`,
    `Target: ${schedule.target}`,
    `Cron: ${schedule.cron}`,
    `Time zone: ${schedule.timeZone}`,
    `Enabled: ${schedule.enabled ? "yes" : "no"}`,
    `Next run: ${schedule.nextRunAt ?? "-"}`,
    `Last run: ${runLabel(schedule.lastRun)}`,
    ...(schedule.input !== undefined ? [`Input: ${JSON.stringify(schedule.input)}`] : []),
    `Console: ${schedule.console.visible ? "visible" : "hidden"}${schedule.console.dispatch ? ", dispatch allowed" : ""}`,
    `Created: ${schedule.createdAt}`,
    `Updated: ${schedule.updatedAt}`,
    ...(automaticRuns === undefined ? [] : [automaticRunsNotice(automaticRuns)]),
    "",
  ].join("\n")
}

function formatRuns(runs: readonly ScheduleRunSummary[]): string {
  if (runs.length === 0) return "No runs.\n"
  return `${table([
    ["RUN", "STATUS", "SCHEDULED AT", "ATTEMPTS", "ERROR"],
    ...runs.map(run => [run.id, run.status, run.scheduledAt, String(run.attemptCount), run.error?.message ?? "-"]),
  ])}\n`
}

function formatAttempts(run: ScheduleRunSummary, attempts: readonly ScheduleRunAttemptSummary[]): string {
  const header = `Run: ${run.id} (${run.status})\n`
  if (attempts.length === 0) return `${header}No attempts.\n`
  return `${header}${table([
    ["ATTEMPT", "STATUS", "STARTED AT", "COMPLETED AT", "ERROR"],
    ...attempts.map(attempt => [attempt.id, attempt.status, attempt.startedAt, attempt.completedAt ?? "-", attempt.error?.message ?? "-"]),
  ])}\n`
}

function formatRun(run: ScheduleRunSummary): string {
  const response = run.response ? ` (HTTP ${run.response.status}${run.response.statusText ? ` ${run.response.statusText}` : ""})` : ""
  return [
    `Run ${run.id}: ${run.status}${response}`,
    ...(run.error ? [`Error: ${run.error.name ? `${run.error.name}: ` : ""}${run.error.message}`] : []),
    "",
  ].join("\n")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringFields(value: Record<string, unknown>, fields: string[]): boolean {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
  return fields.every(field => typeof value[field] === "string")
}

function optionalStrings(value: Record<string, unknown>, fields: string[]): boolean {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
  return fields.every(field => value[field] === undefined || typeof value[field] === "string")
}

function isRunError(value: unknown): boolean {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
  return value === undefined || (isRecord(value) && typeof value.message === "string" && optionalStrings(value, ["name"]))
}

function isRunSummary(value: unknown): value is ScheduleRunSummary {
  return isRecord(value) && stringFields(value, ["id", "scheduleId", "scheduledAt", "target"])
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
    && typeof value.attemptCount === "number" && Number.isInteger(value.attemptCount) && value.attemptCount >= 0
    && (value.status === "pending" || value.status === "running" || value.status === "succeeded" || value.status === "failed")
    && optionalStrings(value, ["completedAt", "startedAt"]) && isRunError(value.error)
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
    && (value.response === undefined || (isRecord(value.response) && typeof value.response.status === "number"
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
      && Number.isInteger(value.response.status) && typeof value.response.statusText === "string"))
}

function isScheduleSummary(value: unknown): value is RuntimeScheduleSummary {
  return isRecord(value) && stringFields(value, ["id", "target", "cron", "timeZone", "createdAt", "updatedAt"])
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
    && typeof value.enabled === "boolean" && isRecord(value.console)
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
    && typeof value.console.visible === "boolean" && typeof value.console.dispatch === "boolean"
    && optionalStrings(value, ["nextRunAt"]) && (value.lastRun === undefined || isRunSummary(value.lastRun))
}

function isAttemptSummary(value: unknown): value is ScheduleRunAttemptSummary {
  return isRecord(value) && stringFields(value, ["id", "runId", "startedAt"])
    && (value.status === "running" || value.status === "succeeded" || value.status === "failed")
    && optionalStrings(value, ["completedAt"]) && isRunError(value.error)
}

function formatResult(operation: ScheduleDevOperation, result: Record<string, unknown>): string | undefined {
  switch (operation) {
    case "list":
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
      if (typeof result.automaticRuns === "boolean" && Array.isArray(result.schedules) && result.schedules.every(isScheduleSummary)) {
        return formatScheduleList({ automaticRuns: result.automaticRuns, schedules: result.schedules })
      }
      break
    case "get":
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
      if (isScheduleSummary(result.schedule) && typeof result.automaticRuns === "boolean") return formatSchedule(result.schedule, result.automaticRuns)
      break
    case "runs":
      if (Array.isArray(result.runs) && result.runs.every(isRunSummary)) return formatRuns(result.runs)
      break
    case "attempts":
      if (isRunSummary(result.run) && Array.isArray(result.attempts) && result.attempts.every(isAttemptSummary)) return formatAttempts(result.run, result.attempts)
      break
    case "run":
      if (isRunSummary(result.run)) return formatRun(result.run)
      break
    case "enable":
    case "disable": {
      if (!isScheduleSummary(result.schedule)) break
      const schedule = result.schedule
      return `${operation === "enable" ? "Enabled" : "Disabled"} Schedule ${schedule.id}.${schedule.nextRunAt ? ` Next run: ${schedule.nextRunAt}.` : ""}\n`
    }
  }
}

async function readFailure(response: Response): Promise<{ code?: string, message: string }> {
  const text = await response.text()
  try {
    const body: unknown = JSON.parse(text)
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
    if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
      return { ...(typeof body.error.code === "string" ? { code: body.error.code } : {}), message: body.error.message }
    }
  }
  catch {
    // Guard rejections use plain text.
  }
  return { message: text || `Schedule Dev request failed with HTTP ${response.status}.` }
}

function writeFailure(parsed: Pick<ParsedScheduleArgs, "json">, context: ScheduleCliContext, failure: { code?: string, message: string }): number {
  if (parsed.json) context.stdout.write(`${JSON.stringify({ error: failure }, null, 2)}\n`)
  else context.stderr.write(`${failure.message}\n`)
  return 1
}

function withTimeout(timeout: number | undefined): { signal?: AbortSignal } {
  return timeout ? { signal: AbortSignal.timeout(timeout) } : {}
}

async function runScheduleCommand(
  command: ScheduleCommand,
  args: string[],
  context: ScheduleCliContext,
  options: ScheduleCliOptions,
): Promise<number> {
  let parsed: ParsedScheduleArgs
  try {
    parsed = parseArgs(command, args, context.env)
  }
  catch (error) {
    const optionEnd = args.indexOf("--")
    if (args.slice(0, optionEnd === -1 ? args.length : optionEnd).includes("--json")) return writeFailure({ json: true }, context, { message: error instanceof Error ? error.message : String(error) })
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    writeUsage(command, context.stderr)
    return 1
  }
  if (parsed.help) {
    writeUsage(command, context.stdout)
    return 0
  }
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeout = withTimeout(parsed.timeout)
  let discoveryFailure = ""
  const server = await discoverViteHubDevServer({
    endpoint: scheduleDevEndpoint,
    fetch: fetchImpl,
    rootDir: context.rootDir,
    serverUrl: parsed.url,
    stderr: { write: chunk => { discoveryFailure += String(chunk) } },
    ...timeout,
  })
  if (!server) return writeFailure(parsed, context, { message: `${discoveryFailure.trim()}\n${scheduleDevServerHint}` })
  if (server.discovery.runtime !== "nitro") {
    return writeFailure(parsed, context, {
      code: "SCHEDULE_DEV_RUNTIME_UNAVAILABLE",
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
      message: typeof server.discovery.message === "string"
        ? server.discovery.message
        : "This Vite Development Server cannot reach the Schedule runtime.",
    })
  }
  const body: ScheduleDevRequestBody = {
    ...(parsed.id !== undefined ? { id: parsed.id } : {}),
    ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
    operation: command.name,
  }
  let response: Response
  try {
    response = await fetchViteHubDevEndpoint(fetchImpl, server.url, scheduleDevEndpoint, {
      body: JSON.stringify(body),
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      ...timeout,
    })
    if (!response.ok) return writeFailure(parsed, context, await readFailure(response))
  }
  catch (error) {
    return writeFailure(parsed, context, { message: `Schedule Dev request failed: ${error instanceof Error ? error.message : String(error)}` })
  }
  const result: unknown = await response.json().catch(() => undefined)
  if (!isRecord(result)) return writeFailure(parsed, context, { message: "The Schedule Dev response is not valid JSON." })
  const formatted = formatResult(command.name, result)
  if (formatted === undefined) return writeFailure(parsed, context, { message: "The Schedule Dev response has an invalid result shape." })
  context.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : formatted)
  // A failed manual run is a command failure, so scripts can check the exit code.
  return command.name === "run" && isRecord(result.run) && result.run.status === "failed" ? 1 : 0
}

/**
 * Runs one `vitehub schedule` command against a running Vite + Nitro Development Server.
 * `args[0]` is the command name, for example `list` or `run`.
 */
export async function runScheduleCli(args: string[], context: ScheduleCliContext, options: ScheduleCliOptions = {}): Promise<number> {
  const [name, ...rest] = args
  const command = scheduleCommands.find(entry => entry.name === name)
  if (!command) {
    context.stderr.write(`${name ? `Unknown schedule command: ${name}\n` : ""}Commands: ${scheduleCommands.map(entry => entry.name).join(", ")}\n`)
    return 1
  }
  return await runScheduleCommand(command, rest, context, options)
}

export function createScheduleCliContributor(options: ScheduleCliOptions = {}): ViteHubCliContributor {
  return {
    namespaces: [{
      description: "Inspect and control Runtime Schedules in a running Vite + Nitro Development Server.",
      features: scheduleCommands.map(command => ({
        description: command.description,
        name: command.name,
        run: async (args: string[], context: ViteHubCliContext) => await runScheduleCommand(command, args, context, options),
        usage: commandUsage(command),
      })),
      name: "schedule",
    }],
  }
}
