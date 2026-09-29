import {
  discoverViteHubDevServer,
  fetchViteHubDevEndpoint,
  readViteHubDevTargetOption,
  resolveViteHubDevServerUrl,
} from "@vite-hub/internal/cli"

import { rateLimitDevHeader, rateLimitDevHeaderValue, rateLimitDevRoute } from "./dev.ts"
import { rateLimitErrorDiagnostics } from "./error-diagnostics.ts"

import type { ViteHubCliContext, ViteHubCliContributor, ViteHubCliStreams } from "@vite-hub/internal/cli"
import type { RateLimitPeekInspection, RateLimitResetInspection } from "./counters.ts"
import type { RateLimitDevOperation, RateLimitDevRequestBody } from "./dev.ts"

export type RateLimitCliContext = Pick<ViteHubCliContext, "cwd" | "env" | "rootDir"> & ViteHubCliStreams

export interface RateLimitCliOptions {
  fetch?: typeof fetch
}

interface RateLimitCommand {
  description: string
  name: RateLimitDevOperation
}

interface ParsedRateLimitArgs {
  help: boolean
  json: boolean
  key?: string
  name?: string
  timeout?: number
  url: string
}

interface RateLimitDevDiscovery {
  message?: unknown
  root?: unknown
  runtime?: unknown
}

interface RateLimitDevFailure {
  error?: { code?: unknown, message?: unknown }
}

const rateLimitDevEndpoint = {
  header: rateLimitDevHeader,
  headerValue: rateLimitDevHeaderValue,
  route: rateLimitDevRoute,
}

const rateLimitDevTargetErrors = {
  invalidInlineTimeout: (message: string) => rateLimitErrorDiagnostics.RATE_LIMIT_R0041({ message }),
  invalidTimeout: (message: string) => rateLimitErrorDiagnostics.RATE_LIMIT_R0041({ message }),
  missingValue: (message: string) => rateLimitErrorDiagnostics.RATE_LIMIT_R0040({ message }),
}

// Nuxt mounts Vite under `/_nuxt/`, so the Rate Limit dev endpoint is not reachable there.
const rateLimitDevServerHint = "`vitehub rate-limit` needs a running Vite + Nitro Development Server with `rateLimit` enabled. Nuxt and plain Vite are not supported."

const rateLimitCommands: readonly RateLimitCommand[] = [
  { description: "Show the counter of one key without consuming a token.", name: "peek" },
  { description: "Delete the counter of one key, where the provider supports it.", name: "reset" },
]

function commandUsage(command: RateLimitCommand): string {
  return `vitehub rate-limit ${command.name} <id> <key> [--json] [--url <url>]`
}

function writeUsage(command: RateLimitCommand, stream: ViteHubCliStreams["stdout"]): void {
  stream.write([
    `Usage: ${commandUsage(command)}`,
    "",
    command.description,
    "The command calls the Rate Limit runtime of a running Vite + Nitro Development Server.",
    "`<id>` is the stable ID of `requireRateLimit()`. `<key>` is the limited key, for example a client IP or user ID.",
    "",
    "Options:",
    "  --json            Print JSON.",
    "  --url <url>       Compatible Vite Development Server URL. Defaults to http://localhost:5173.",
    "  --timeout <ms>    Request timeout.",
    "  -h, --help        Show this help.",
    "",
  ].join("\n"))
}

function parseArgs(args: readonly string[], env: NodeJS.ProcessEnv): ParsedRateLimitArgs {
  const parsed: ParsedRateLimitArgs = { help: false, json: false, url: resolveViteHubDevServerUrl(env) }
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
    const targetOption = readViteHubDevTargetOption(args, index, parsed, rateLimitDevTargetErrors)
    if (targetOption !== undefined) {
      index += targetOption
      continue
    }
    if (arg.startsWith("-")) throw rateLimitErrorDiagnostics.RATE_LIMIT_R0040({ message: `Unknown option: ${arg}.` })
    if (parsed.name === undefined) {
      parsed.name = arg
      continue
    }
    if (parsed.key === undefined) {
      parsed.key = arg
      continue
    }
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0040({ message: `Unexpected argument: ${arg}.` })
  }
  if (!parsed.help && !parsed.name) throw rateLimitErrorDiagnostics.RATE_LIMIT_R0040({ message: "Missing Rate Limit ID." })
  if (!parsed.help && !parsed.key) throw rateLimitErrorDiagnostics.RATE_LIMIT_R0040({ message: "Missing Rate Limit key." })
  return parsed
}

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  return rows.map(row => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  ")).join("\n")
}

function scopeNotice(scope: string): string {
  return scope === "process"
    ? "Scope: process. The counter exists only in this server process."
    : `Scope: ${scope}.`
}

function formatPeek(result: RateLimitPeekInspection): string {
  const header = `Rate Limit ${result.name}, key ${result.key}\nProvider: ${result.provider}\n`
  if (result.status !== "known") return `${header}${result.status === "unused" ? "No counter" : "Counter unknown"}: ${result.reason}\n`
  return `${header}${scopeNotice(result.scope)}\n${table([
    ["LIMIT", "WINDOW", "USED", "REMAINING", "RESETS AT"],
    ...result.counters.map(counter => [
      String(counter.limit),
      counter.window,
      String(counter.used),
      String(counter.remaining),
      counter.resetAt === undefined ? "-" : new Date(counter.resetAt).toISOString(),
    ]),
  ])}\n`
}

function formatReset(result: RateLimitResetInspection): string {
  if (result.status !== "reset") return `Rate Limit ${result.name}, key ${result.key}\nProvider: ${result.provider}\nNot reset: ${result.reason}\n`
  return `Reset Rate Limit ${result.name} for key ${result.key}.\nProvider: ${result.provider}\n${scopeNotice(result.scope)}\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readFailure(response: Response): Promise<{ code?: string, message: string }> {
  const text = await response.text()
  try {
    const body: RateLimitDevFailure = JSON.parse(text)
    if (typeof body.error?.message === "string") {
      return { ...(typeof body.error.code === "string" ? { code: body.error.code } : {}), message: body.error.message }
    }
  }
  catch {
    // Guard rejections use plain text.
  }
  return { message: text || `Rate Limit Dev request failed with HTTP ${response.status}.` }
}

function writeFailure(parsed: ParsedRateLimitArgs, context: RateLimitCliContext, failure: { code?: string, message: string }): number {
  if (parsed.json) context.stdout.write(`${JSON.stringify({ error: failure }, null, 2)}\n`)
  else context.stderr.write(`${failure.message}\n`)
  return 1
}

function withTimeout(timeout: number | undefined): Pick<RequestInit, "signal"> {
  return timeout ? { signal: AbortSignal.timeout(timeout) } : {}
}

async function runRateLimitCommand(
  command: RateLimitCommand,
  args: string[],
  context: RateLimitCliContext,
  options: RateLimitCliOptions,
): Promise<number> {
  let parsed: ParsedRateLimitArgs
  try {
    parsed = parseArgs(args, context.env)
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
  const server = await discoverViteHubDevServer<RateLimitDevDiscovery>({
    endpoint: rateLimitDevEndpoint,
    fetch: fetchImpl,
    rootDir: context.rootDir,
    serverUrl: parsed.url,
    stderr: context.stderr,
  })
  if (!server) {
    context.stderr.write(`${rateLimitDevServerHint}\n`)
    return 1
  }
  if (server.discovery.runtime !== "nitro") {
    return writeFailure(parsed, context, {
      code: "RATE_LIMIT_DEV_RUNTIME_UNAVAILABLE",
      message: typeof server.discovery.message === "string"
        ? server.discovery.message
        : "This Vite Development Server cannot reach the Rate Limit runtime.",
    })
  }
  const body: RateLimitDevRequestBody = { key: parsed.key!, name: parsed.name!, operation: command.name }
  let response: Response
  try {
    response = await fetchViteHubDevEndpoint(fetchImpl, server.url, rateLimitDevEndpoint, {
      body: JSON.stringify(body),
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      ...withTimeout(parsed.timeout),
    })
  }
  catch (error) {
    return writeFailure(parsed, context, { message: `Rate Limit Dev request failed: ${error instanceof Error ? error.message : String(error)}` })
  }
  if (!response.ok) return writeFailure(parsed, context, await readFailure(response))
  const result: unknown = await response.json().catch(() => undefined)
  if (!isRecord(result) || typeof result.status !== "string") {
    return writeFailure(parsed, context, { message: "The Rate Limit Dev response is not valid JSON." })
  }
  // SAFETY: the Rate Limit dev handler of the same package version writes these shapes.
  const output = command.name === "peek"
    ? formatPeek(result as unknown as RateLimitPeekInspection)
    : formatReset(result as unknown as RateLimitResetInspection)
  context.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : output)
  // A counter that the provider cannot read or reset is a command failure, so scripts can check the exit code.
  return result.status === "unsupported" || result.status === "unavailable" ? 1 : 0
}

/**
 * Runs one `vitehub rate-limit` command against a running Vite + Nitro Development Server.
 * `args[0]` is the command name, `peek` or `reset`.
 */
export async function runRateLimitCli(args: string[], context: RateLimitCliContext, options: RateLimitCliOptions = {}): Promise<number> {
  const [name, ...rest] = args
  const command = rateLimitCommands.find(entry => entry.name === name)
  if (!command) {
    context.stderr.write(`${name ? `Unknown rate-limit command: ${name}\n` : ""}Commands: ${rateLimitCommands.map(entry => entry.name).join(", ")}\n`)
    return 1
  }
  return await runRateLimitCommand(command, rest, context, options)
}

export function createRateLimitCliContributor(options: RateLimitCliOptions = {}): ViteHubCliContributor {
  return {
    namespaces: [{
      description: "Read and reset Rate Limit counters in a running Vite + Nitro Development Server.",
      features: rateLimitCommands.map(command => ({
        description: command.description,
        name: command.name,
        run: async (args: string[], context: ViteHubCliContext) => await runRateLimitCommand(command, args, context, options),
        usage: commandUsage(command),
      })),
      name: "rate-limit",
    }],
  }
}
