import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { asUnknownBoundary, hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"
import { discoverViteHubDevServer, fetchViteHubDevEndpoint, readViteHubDevTargetOption, resolveViteHubDevServerUrl } from "@vite-hub/internal/cli"
import { agentInvocationsDevGuard, agentInvocationsDevRoute, agentInvocationsDevRuntimeUnavailableMessage } from "../invocations-dev.ts"
import { isCompatibleAgentDevServerRoot } from "./agent-info-cli.ts"
import type { AgentInvocationCancelResult, AgentInvocationListResult, AgentInvocationRecord } from "../invocations.ts"
import type { AgentInvocationsDevRequestBody } from "../invocations-dev.ts"
import type { AgentInvocationDetailResult } from "../invocations-vue.ts"
import type { RuntimeDiagnosticError } from "@vite-hub/runtime"
import { agentDiagnostics } from "../agent-diagnostics.ts"

interface AgentInvocationsCliContext {
  env: NodeJS.ProcessEnv
  /** Project root that the Compatible Vite Development Server must serve. Defaults to the current directory. */
  rootDir?: string
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

export interface AgentInvocationsCliOptions {
  fetch?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
  timeout?: number
}

type Action = "delete" | "list" | "prune" | "show" | "tail"

const actions = new Set<string>(["delete", "list", "prune", "show", "tail"] satisfies Action[])

function isAction(value: string): value is Action {
  return actions.has(value)
}

interface ParsedArgs {
  action?: "cancel" | "list" | "show" | "tail"
  help: boolean
  id?: string
  interval: number
  json: boolean
  limit?: number
  olderThanMs?: number
  status?: string
  timeout?: number
  url: string
  urlSet: boolean
}

const cancelEndpoint = { ...agentInvocationsDevGuard, route: agentInvocationsDevRoute }

interface AgentInvocationsDevDiscovery {
  message?: unknown
  root?: unknown
  runtime?: unknown
}

function parseCancelDiscovery(value: unknown): AgentInvocationsDevDiscovery {
  if (!isRuntimeRecord(value) || !hasRuntimeType(value.root, "string") || !hasRuntimeType(value.runtime, "string")
    || (value.message !== undefined && !hasRuntimeType(value.message, "string"))) {
    throw agentDiagnostics.AGENT_R0971({ message: "Invocation cancellation discovery returned an invalid response." })
  }
  const discovery: AgentInvocationsDevDiscovery = { root: value.root, runtime: value.runtime }
  if (value.message !== undefined) discovery.message = value.message
  return discovery
}

const devTargetErrors = {
  invalidInlineTimeout: (message: string) => agentDiagnostics.AGENT_R0503({ message }),
  invalidTimeout: (message: string) => agentDiagnostics.AGENT_R0503({ message }),
  missingValue: (message: string) => agentDiagnostics.AGENT_R0502({ message }),
}

const defaultPruneAgeMs = 30 * 24 * 60 * 60 * 1000
const durationUnits: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, ms: 1, s: 1_000, w: 604_800_000 }

function usage(context: AgentInvocationsCliContext): void {
  context.stdout.write([
    "Usage: vitehub agent invocations <list|show|tail|cancel> [id] [options]",
    "",
    "Inspect an application's Agent Invocation journal over HTTP.",
    "cancel asks a running Vite + Nitro Development Server to cancel a pending or running Invocation.",
    "",
    "Options:",
    "  --url <url>       Invocation endpoint. Defaults to http://localhost:5173/api/invocations.",
    "                    For cancel, the Vite Development Server URL. Defaults to VITEHUB_DEV_SERVER_URL or http://localhost:5173.",
    "  --timeout <ms>    Request timeout. Defaults to 30000.",
    "  --status <status> Filter list results by status.",
    "  --limit <count>   Limit list results.",
    "  --interval <ms>   Tail polling interval. Defaults to 1000.",
    "  --json            Print JSON or JSON Lines.",
    "  -h, --help        Show this help.",
    "",
  ].join("\n"))
}

function optionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith("-")) throw agentDiagnostics.AGENT_R0502({ message: `Missing value for ${flag}.` })
  return value
}

function positiveInteger(value: string, flag: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result <= 0) throw agentDiagnostics.AGENT_R0503({ message: `${flag} requires a positive integer.` })
  return result
}

function duration(value: string, flag: string): number {
  const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(value.trim())
  const result = match ? Number(match[1]) * durationUnits[match[2]!]! : Number.NaN
  if (!Number.isSafeInteger(result)) throw agentDiagnostics.AGENT_R0930({ message: `${flag} requires a duration such as 90m, 12h, or 30d.` })
  return result
}

function redactCliArgument(argument: string): string {
  const separator = argument.startsWith("-") ? argument.indexOf("=") : -1
  const prefix = separator === -1 ? "" : argument.slice(0, separator + 1)
  const value = separator === -1 ? argument : argument.slice(separator + 1)
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) return argument
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return `${prefix}${url.href}`
  }
  catch {
    return `${prefix}[redacted]`
  }
}

function parse(args: string[], env: NodeJS.ProcessEnv): ParsedArgs {
  const parsed: ParsedArgs = {
    dryRun: false,
    help: false,
    interval: 1_000,
    json: false,
    url: env.VITEHUB_AGENT_INVOCATIONS_URL || "http://localhost:5173/api/invocations",
    urlSet: false,
  }
  const target: { timeout?: number, url: string } = { url: parsed.url }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    const used = readViteHubDevTargetOption(args, index, target, devTargetErrors)
    if (used !== undefined) {
      index += used
      if (argument === "--url" || argument === "--server" || argument.startsWith("--url=")) parsed.urlSet = true
      parsed.url = target.url
      if (target.timeout !== undefined) parsed.timeout = target.timeout
    }
    else if (argument === "-h" || argument === "--help") parsed.help = true
    else if (argument === "--json") parsed.json = true
    else if (argument === "--status") {
      parsed.status = optionValue(args, index, argument)
      index += 1
    }
    else if (argument.startsWith("--status=")) parsed.status = argument.slice(9)
    else if (argument === "--limit") {
      parsed.limit = positiveInteger(optionValue(args, index, argument), argument)
      index += 1
    }
    else if (argument.startsWith("--limit=")) parsed.limit = positiveInteger(argument.slice(8), "--limit")
    else if (argument === "--interval") {
      parsed.interval = positiveInteger(optionValue(args, index, argument), argument)
      index += 1
    }
    else if (argument.startsWith("--interval=")) parsed.interval = positiveInteger(argument.slice(11), "--interval")
    else if (argument.startsWith("-")) throw agentDiagnostics.AGENT_R0504({ message: `Unknown option: ${argument}.` })
    else if (!parsed.action && (argument === "cancel" || argument === "list" || argument === "show" || argument === "tail")) parsed.action = argument
    else if (!parsed.id) parsed.id = argument
    else throw agentDiagnostics.AGENT_R0505({ message: `Unexpected argument: ${argument}.` })
  }
  if (!parsed.help && !parsed.action) throw agentDiagnostics.AGENT_R0506({ message: "Choose list, show, tail, or cancel." })
  if (!parsed.help && parsed.action !== "list" && !parsed.id) throw agentDiagnostics.AGENT_R0507({ message: `${parsed.action} requires an invocation id.` })
  // cancel targets the Vite Development Server, not the application inspection route.
  if (parsed.action === "cancel" && !parsed.urlSet) parsed.url = resolveViteHubDevServerUrl(env)
  return parsed
}

function endpoint(parsed: ParsedArgs, id?: string): URL {
  const base = new URL(parsed.url)
  if (id) base.pathname = `${base.pathname.replace(/\/$/, "")}/${encodeURIComponent(id)}`
  if (!id && parsed.status) base.searchParams.set("status", parsed.status)
  if (!id && parsed.limit) base.searchParams.set("limit", String(parsed.limit))
  return base
}

type ResponseParser<T> = (value: unknown) => T

function isInvocationSummary(value: unknown): boolean {
  return isRuntimeRecord(value)
    && hasRuntimeType(value.createdAt, "string")
    && hasRuntimeType(value.cursor, "string")
    && hasRuntimeType(value.id, "string")
    && hasRuntimeType(value.status, "string")
    && hasRuntimeType(value.traceId, "string")
    && hasRuntimeType(value.updatedAt, "string")
    && (value.error === undefined || isRuntimeRecord(value.error))
}

function parseInvocationList(value: unknown): AgentInvocationListResult {
  if (!isRuntimeRecord(value) || !Array.isArray(value.invocations) || value.invocations.some(record => !isInvocationSummary(record)) || value.cursor !== undefined && !hasRuntimeType(value.cursor, "string")) {
    throw agentDiagnostics.AGENT_R0508({ message: "Invocation inspection returned an invalid list response." })
  }
  // SAFETY: The list parser validates its cursor and every summary field consumed by the CLI.
  return asUnknownBoundary(value) as AgentInvocationListResult
}

function parseInvocationDetail(value: unknown): AgentInvocationDetailResult {
  if (!isRuntimeRecord(value) || !isInvocationSummary(value.invocation) || !Array.isArray(value.observations)) {
    throw agentDiagnostics.AGENT_R0509({ message: "Invocation inspection returned an invalid detail response." })
  }
  for (const observation of value.observations) {
    if (!isRuntimeRecord(observation) || !hasRuntimeType(observation.name, "string") || !hasRuntimeType(observation.sequence, "number") || !hasRuntimeType(observation.timestamp, "string")) {
      throw agentDiagnostics.AGENT_R0510({ message: "Invocation inspection returned an invalid observation." })
    }
  }
  // SAFETY: The detail parser validates the invocation summary and each observation field consumed by the CLI.
  return asUnknownBoundary(value) as AgentInvocationDetailResult
}

async function request<T>(url: URL, fetchImpl: typeof fetch, timeout: number, parseResponse: ResponseParser<T>): Promise<T> {
  const response = await fetchImpl(url.href, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw agentDiagnostics.AGENT_R0511({ message: (await response.text()).trim() || `Invocation inspection failed with status ${response.status}.` })
  const value: unknown = await response.json()
  return parseResponse(value)
}

const cancelOutcomes = new Set<unknown>(["not-found", "requested", "terminal", "unavailable"])

function parseCancelResult(value: unknown): AgentInvocationCancelResult {
  if (
    !isRuntimeRecord(value)
    || !hasRuntimeType(value.id, "string")
    || !cancelOutcomes.has(value.outcome)
    || (value.status !== undefined && !hasRuntimeType(value.status, "string"))
    || (value.notEnforcedBy !== undefined && !hasRuntimeType(value.notEnforcedBy, "string"))
    || (value.delivery !== undefined && value.delivery !== "journal" && value.delivery !== "local")
  ) {
    throw agentDiagnostics.AGENT_R0971({ message: "Invocation cancel returned an invalid response." })
  }
  // SAFETY: The parser validates every cancel result field consumed by the CLI.
  return asUnknownBoundary(value) as AgentInvocationCancelResult
}

async function requestCancel(parsed: ParsedArgs, id: string, context: AgentInvocationsCliContext, fetchImpl: typeof fetch, timeout: number): Promise<AgentInvocationCancelResult | undefined> {
  const rootDir = context.rootDir ?? process.cwd()
  const discoveryOptions = {
    parseDiscovery: parseCancelDiscovery,
    endpoint: cancelEndpoint,
    fetch: (input: string | URL | Request, init?: RequestInit) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeout) }),
    isCompatibleRoot: isCompatibleAgentDevServerRoot,
    rootDir,
    serverUrl: parsed.url,
    stderr: context.stderr,
  }
  const server = await discoverViteHubDevServer<AgentInvocationsDevDiscovery>(discoveryOptions)
  if (!server) return
  const { url } = server
  const discovery = parseCancelDiscovery(server.discovery)
  // Nuxt and plain Vite do not run Nitro in the Vite process, so the cancel cannot reach the application runtime.
  if (discovery.runtime !== "nitro") {
    context.stderr.write(`${hasRuntimeType(discovery.message, "string") ? discovery.message : agentInvocationsDevRuntimeUnavailableMessage}\n`)
    return
  }
  const body: AgentInvocationsDevRequestBody = { id, operation: "cancel" }
  const response = await fetchViteHubDevEndpoint(fetchImpl, url, cancelEndpoint, {
    body: JSON.stringify(body),
    headers: { "accept": "application/json", "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(timeout),
  })
  if (!response.ok) throw agentDiagnostics.AGENT_R0972({ message: await cancelFailureMessage(response) })
  return parseCancelResult(await response.json())
}

async function cancelFailureMessage(response: Response): Promise<string> {
  const text = (await response.text()).trim()
  try {
    const value: unknown = JSON.parse(text)
    const message: unknown = isRuntimeRecord(value) && isRuntimeRecord(value.error) ? value.error.message : undefined
    if (hasRuntimeType(message, "string") && message) return message
  }
  catch {
    // Plain text responses carry the message as the body.
  }
  return text || `Invocation cancel failed with status ${response.status}.`
}

function cancelMessage(result: AgentInvocationCancelResult): string {
  if (result.outcome === "not-found") return `${result.id} not found`
  if (result.outcome === "terminal") return result.notEnforcedBy
    ? `${result.id} journal is ${result.status ?? "terminal"}; local abort requested, not enforced by ${result.notEnforcedBy}`
    : `${result.id} already ${result.status ?? "finished"}`
  if (result.outcome === "unavailable") return `${result.id} cancel request was not recorded`
  if (result.notEnforcedBy) return `${result.id} cancel requested, not enforced by ${result.notEnforcedBy}`
  if (result.delivery === "journal") return `${result.id} cancel request recorded; execution stop is unconfirmed`
  return `${result.id} cancel requested`
}

function cancelExitCode(result: AgentInvocationCancelResult): number {
  if (result.outcome === "requested") return 0
  return result.outcome === "terminal" && result.status === "cancelled" && !result.notEnforcedBy ? 0 : 1
}

function formatError(error: RuntimeDiagnosticError, indent = ""): string {
  const lines = [`${indent}${error.name || "Error"}: ${error.message}`]
  if (error.cause) lines.push(formatError(error.cause, `${indent}  caused by `))
  for (const nested of error.errors || []) lines.push(formatError(nested, `${indent}  `))
  return lines.join("\n")
}

function summary(record: AgentInvocationRecord | AgentInvocationListResult["invocations"][number]): string {
  const error = record.error ? ` ${formatError(record.error)}` : ""
  return `${record.id} ${record.status} ${record.updatedAt}${error}`
}

function writeRecord(context: AgentInvocationsCliContext, record: AgentInvocationRecord, json: boolean): void {
  if (json) context.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
  else {
    context.stdout.write(`${summary(record)}\n`)
    for (const observation of record.observations) {
      context.stdout.write(`  ${observation.sequence} ${observation.timestamp} ${observation.name}\n`)
    }
  }
}

interface JournalDatabase {
  authToken?: string
  /** Location without credentials, query, or fragment. Safe to print. */
  label: string
  path?: string
  /** Credentials from the URL and environment. Removed from every printed error. */
  secrets: string[]
  url: string
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return value
  }
}

function journalDatabase(parsed: ParsedArgs, context: AgentInvocationsCliContext): JournalDatabase {
  const root = resolveViteHubProjectRoot(context.rootDir ?? process.cwd())
  const explicit = parsed.database?.trim() || context.env.VITEHUB_AGENT_INVOCATIONS_DATABASE_URL?.trim()
  const configured = explicit || context.env.VITEHUB_CONSOLE_DATABASE_URL?.trim()
  const authToken = explicit
    ? context.env.VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN
    : context.env.VITEHUB_CONSOLE_DATABASE_AUTH_TOKEN
  const token = authToken ? { authToken } : {}
  const secrets = authToken ? [authToken] : []
  const isWindowsPath = /^[a-z]:[\\/]/i.test(configured ?? "")
  if (configured && !isWindowsPath && !/^file:/i.test(configured) && /^[a-z][a-z\d+.-]+:/i.test(configured)) {
    let location: URL
    try {
      location = new URL(configured)
    }
    catch {
      throw agentDiagnostics.AGENT_R0931({ message: "The Agent Invocation journal database URL is invalid." })
    }
    for (const value of [location.username, location.password]) {
      if (value) secrets.push(value, safeDecode(value))
    }
    for (const value of location.searchParams.values()) {
      if (value) secrets.push(value, encodeURIComponent(value))
    }
    return { ...token, label: `${location.protocol}//${location.host}${location.pathname === "/" ? "" : location.pathname}`, secrets, url: configured }
  }
  const target = configured || resolve(root, ".vitehub/data/console.sqlite")
  const withoutFragment = target.split("#", 1)[0]!
  const queryIndex = withoutFragment.indexOf("?")
  const location = queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex)
  const query = queryIndex === -1 ? "" : withoutFragment.slice(queryIndex)
  const path = /^file:\//i.test(location)
    ? fileURLToPath(location)
    : resolve(root, /^file:/i.test(location) ? decodeURIComponent(location.slice(5)) : location)
  for (const value of new URLSearchParams(query).values()) {
    if (value) secrets.push(value)
  }
  return { ...token, label: path, path, secrets, url: `${pathToFileURL(path).href}${query}` }
}

async function withJournalStore<T>(parsed: ParsedArgs, context: AgentInvocationsCliContext, use: (store: AgentInvocationStore) => Promise<T>): Promise<T> {
  const database = journalDatabase(parsed, context)
  if (database.path !== undefined && !existsSync(database.path)) {
    throw agentDiagnostics.AGENT_R0931({ message: `No Agent Invocation journal exists at ${database.label}. Pass --database with the journal URL.` })
  }
  const [{ createClient }, { createLibsqlAgentInvocationStore }] = await Promise.all([
    import("@libsql/client"),
    import("../invocations/sqlite.ts"),
  ])
  let client: ReturnType<typeof createClient>
  try {
    client = createClient({ ...(database.authToken ? { authToken: database.authToken } : {}), url: database.url })
  }
  catch (error) {
    throw redactedJournalError(error, database)
  }
  try {
    const table = `${parsed.tablePrefix ?? "vitehub_agent_"}invocations`
    const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false, ...(parsed.tablePrefix === undefined ? {} : { tablePrefix: parsed.tablePrefix }) })
    const existing = await client.execute({ args: [table], sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?" })
    if (!existing.rows.length) {
      throw agentDiagnostics.AGENT_R0931({ message: `No Agent Invocation journal table ${table} exists in ${database.label}.` })
    }
    return await use(store)
  }
  catch (error) {
    throw redactedJournalError(error, database)
  }
  finally {
    client.close()
  }
}

// Database clients can echo the connection URL or token. Print only the redacted location.
function redactedJournalError(error: unknown, database: JournalDatabase): unknown {
  if (!(error instanceof Error)) return error
  let message = error.message.split(database.url).join(database.label)
  for (const secret of database.secrets) message = message.split(secret).join("[redacted]")
  if (message === error.message) return error
  return agentDiagnostics.AGENT_R0931({ message })
}

async function deleteInvocation(parsed: ParsedArgs, context: AgentInvocationsCliContext, id: string): Promise<number> {
  const outcome = await withJournalStore(parsed, context, async store => await store.delete!(id))
  if (parsed.json) context.stdout.write(`${JSON.stringify({ id, outcome })}\n`)
  else if (outcome === "deleted") context.stdout.write(`Deleted ${id}.\n`)
  if (outcome === "deleted") return 0
  if (!parsed.json) {
    context.stderr.write(outcome === "not-found"
      ? `Agent Invocation ${id} was not found.\n`
      : `Agent Invocation ${id} is pending or running. Wait until it completes, fails, or is cancelled.\n`)
  }
  return 1
}

async function pruneInvocations(parsed: ParsedArgs, context: AgentInvocationsCliContext): Promise<number> {
  const olderThanMs = parsed.olderThanMs ?? defaultPruneAgeMs
  const cutoff = new Date(Date.now() - olderThanMs)
  if (Number.isNaN(cutoff.getTime())) {
    throw agentDiagnostics.AGENT_R0930({ message: "--older-than must produce a cutoff within JavaScript's Date range." })
  }
  const updatedBefore = cutoff.toISOString()
  const result = await withJournalStore(parsed, context, async store => await store.prune!({ ...(parsed.dryRun ? { dryRun: true } : {}), updatedBefore }))
  if (parsed.json) {
    context.stdout.write(`${JSON.stringify({ dryRun: result.dryRun, ids: result.ids, olderThanMs, updatedBefore }, null, 2)}\n`)
    return 0
  }
  for (const id of result.ids) context.stdout.write(`${id}\n`)
  const count = `${result.ids.length} terminal Agent Invocation${result.ids.length === 1 ? "" : "s"}`
  context.stdout.write(`${result.dryRun ? "Would delete" : "Deleted"} ${count} last updated before ${updatedBefore}.\n`)
  return 0
}

function detailRecord(result: AgentInvocationDetailResult): AgentInvocationRecord {
  return { ...result.invocation, observations: result.observations }
}

export async function runAgentInvocationsCli(
  args: string[],
  context: AgentInvocationsCliContext,
  options: AgentInvocationsCliOptions = {},
): Promise<number> {
  let parsed: ParsedArgs
  try {
    parsed = parse(args, context.env)
  }
  catch (error) {
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    usage(context)
    return 1
  }
  if (parsed.help) {
    usage(context)
    return 0
  }
  const fetchImpl = options.fetch || globalThis.fetch
  const timeout = parsed.timeout ?? options.timeout ?? 30_000
  try {
    if (parsed.action === "cancel") {
      const result = await requestCancel(parsed, parsed.id!, context, fetchImpl, timeout)
      if (!result) return 1
      context.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : `${cancelMessage(result)}\n`)
      return cancelExitCode(result)
    }
    if (parsed.action === "list") {
      const result = await request(endpoint(parsed), fetchImpl, timeout, parseInvocationList)
      if (parsed.json) context.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      else for (const record of result.invocations) context.stdout.write(`${summary(record)}\n`)
      return 0
    }
    if (parsed.action === "show") {
      writeRecord(context, detailRecord(await request(endpoint(parsed, parsed.id), fetchImpl, timeout, parseInvocationDetail)), parsed.json)
      return 0
    }

    const sleep = options.sleep || (async milliseconds => await new Promise(resolve => setTimeout(resolve, milliseconds)))
    let sequence = 0
    for (;;) {
      const record = detailRecord(await request(endpoint(parsed, parsed.id), fetchImpl, timeout, parseInvocationDetail))
      for (const observation of record.observations.filter(observation => observation.sequence > sequence)) {
        sequence = Math.max(sequence, observation.sequence)
        context.stdout.write(parsed.json ? `${JSON.stringify(observation)}\n` : `${observation.sequence} ${observation.timestamp} ${observation.name}\n`)
      }
      if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") {
        if (record.error) context.stderr.write(`${formatError(record.error)}\n`)
        return record.status === "completed" ? 0 : 1
      }
      await sleep(parsed.interval)
    }
  }
  catch (error) {
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
