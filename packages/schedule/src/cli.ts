import * as v from "valibot"
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

interface ScheduleDevDiscovery {
  message?: unknown
  root?: unknown
  runtime?: unknown
}

const scheduleDevFailureSchema = v.object({ error: v.optional(v.object({ code: v.optional(v.string()), message: v.optional(v.string()) })) })

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
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
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
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasResultShape(operation: ScheduleDevOperation, result: Record<string, unknown>): boolean {
  switch (operation) {
    case "list":
      return Array.isArray(result.schedules)
    case "get":
    case "enable":
    case "disable":
      return isRecord(result.schedule)
    case "runs":
      return Array.isArray(result.runs)
    case "attempts":
      return isRecord(result.run) && Array.isArray(result.attempts)
    case "run":
      return isRecord(result.run)
  }
}

function formatResult(operation: ScheduleDevOperation, result: Record<string, unknown>): string {
  // SAFETY: the Schedule dev handler of the same package version writes these shapes.
  switch (operation) {
    case "list":
      // SAFETY: the guarded endpoint in this package returns the RuntimeScheduleInspection shape for list.
      return formatScheduleList(result as RuntimeScheduleInspection)
    case "get":
      // SAFETY: the guarded endpoint in this package returns a RuntimeScheduleSummary under schedule.
      return formatSchedule(result.schedule as RuntimeScheduleSummary, result.automaticRuns === true)
    case "runs":
      // SAFETY: the guarded endpoint in this package returns ScheduleRunSummary[] under runs.
      return formatRuns(result.runs as ScheduleRunSummary[])
    case "attempts":
      // SAFETY: the guarded endpoint in this package returns a ScheduleRunSummary and attempts under these keys.
      return formatAttempts(result.run as ScheduleRunSummary, result.attempts as ScheduleRunAttemptSummary[])
    case "run":
      // SAFETY: the guarded endpoint in this package returns a ScheduleRunSummary under run.
      return formatRun(result.run as ScheduleRunSummary)
    case "enable":
    case "disable": {
      const schedule = result.schedule as RuntimeScheduleSummary
      return `${operation === "enable" ? "Enabled" : "Disabled"} Schedule ${schedule.id}.${schedule.nextRunAt ? ` Next run: ${schedule.nextRunAt}.` : ""}\n`
    }
  }
}

async function readFailure(response: Response): Promise<{ code?: string, message: string }> {
  const text = await response.text()
  try {
    const parsed = v.safeParse(scheduleDevFailureSchema, JSON.parse(text))
    if (parsed.success && parsed.output.error?.message !== undefined) {
      const failure: { code?: string, message: string } = { message: parsed.output.error.message }
      if (parsed.output.error.code !== undefined) failure.code = parsed.output.error.code
      return failure
    }
  }
  catch {
    // Guard rejections use plain text.
  }
  return { message: text || `Schedule Dev request failed with HTTP ${response.status}.` }
}

function writeFailure(parsed: ParsedScheduleArgs, context: ScheduleCliContext, failure: { code?: string, message: string }): number {
  if (parsed.json) context.stdout.write(`${JSON.stringify({ error: failure }, null, 2)}\n`)
  else context.stderr.write(`${failure.message}\n`)
  return 1
}

function withTimeout(timeout: number | undefined): Pick<RequestInit, "signal"> {
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
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    writeUsage(command, context.stderr)
    return 1
  }
  if (parsed.help) {
    writeUsage(command, context.stdout)
    return 0
  }
  const fetchImpl = options.fetch ?? globalThis.fetch
  const server = await discoverViteHubDevServer<ScheduleDevDiscovery>({
    endpoint: scheduleDevEndpoint,
    fetch: fetchImpl,
    rootDir: context.rootDir,
    serverUrl: parsed.url,
    stderr: context.stderr,
  })
  if (!server) {
    context.stderr.write(`${scheduleDevServerHint}\n`)
    return 1
  }
  if (server.discovery.runtime !== "nitro") {
    return writeFailure(parsed, context, {
      code: "SCHEDULE_DEV_RUNTIME_UNAVAILABLE",
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
      ...withTimeout(parsed.timeout),
    })
  }
  catch (error) {
    return writeFailure(parsed, context, { message: `Schedule Dev request failed: ${error instanceof Error ? error.message : String(error)}` })
  }
  if (!response.ok) return writeFailure(parsed, context, await readFailure(response))
  const result: unknown = await response.json().catch(() => undefined)
  if (!isRecord(result)) return writeFailure(parsed, context, { message: "The Schedule Dev response is not valid JSON." })
  if (!hasResultShape(command.name, result)) return writeFailure(parsed, context, { message: "The Schedule Dev response has an invalid shape." })
  context.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : formatResult(command.name, result))
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
