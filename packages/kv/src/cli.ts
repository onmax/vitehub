import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
  discoverViteHubDevServer,
  fetchViteHubDevEndpoint,
  readViteHubDevTargetOption,
  resolveViteHubDevServerUrl,
} from "@vite-hub/internal/cli"

import { kvDevDefaultListLimit, kvDevHeader, kvDevHeaderValue, kvDevMaximumListLimit, kvDevRoute } from "./dev.ts"
import { kvErrorDiagnostics } from "./error-diagnostics.ts"

import type { ViteHubCliContext, ViteHubCliContributor, ViteHubCliStreams } from "@vite-hub/internal/cli"
import type { KVDevOperation, KVDevRequestBody } from "./dev.ts"
import type { KVDevDeleteResult, KVDevGetResult, KVDevHasResult, KVDevListResult, KVDevSetResult } from "./runtime/dev.ts"

export type KVCliContext = Pick<ViteHubCliContext, "cwd" | "env" | "rootDir"> & ViteHubCliStreams

export interface KVCliOptions {
  fetch?: typeof fetch
}

type KVCliOption = "cursor" | "json-value" | "limit" | "prefix" | "ttl"

interface KVCommand {
  description: string
  key: boolean
  name: KVDevOperation
  options: readonly KVCliOption[]
  value?: boolean
}

interface ParsedKVArgs {
  cursor?: string
  help: boolean
  json: boolean
  jsonValue: boolean
  key?: string
  limit?: number
  prefix?: string
  store?: string
  timeout?: number
  ttl?: number
  url: string
  value?: string
}

interface KVDevDiscovery {
  message?: unknown
  root?: unknown
  runtime?: unknown
}

interface KVCliFailure {
  code?: string
  message: string
}

const kvDevEndpoint = {
  header: kvDevHeader,
  headerValue: kvDevHeaderValue,
  route: kvDevRoute,
}

const kvDevTargetErrors = {
  invalidInlineTimeout: (message: string) => kvErrorDiagnostics.KV_R0019({ message }),
  invalidTimeout: (message: string) => kvErrorDiagnostics.KV_R0019({ message }),
  missingValue: (message: string) => kvErrorDiagnostics.KV_R0019({ message }),
}

// Nuxt mounts Vite under `/_nuxt/`, so the KV dev endpoint is not reachable there.
const kvDevServerHint = "`vitehub kv` needs a running Vite + Nitro Development Server with `kv` enabled. Nuxt and plain Vite are not supported."

const kvCommands: readonly KVCommand[] = [
  { description: "List keys of a KV store, one page at a time.", key: false, name: "list", options: ["prefix", "limit", "cursor"] },
  { description: "Print the value of one key.", key: true, name: "get", options: [] },
  { description: "Check if a key exists. The exit code is 0 when it exists and 1 when it does not.", key: true, name: "has", options: [] },
  { description: "Write the value of one key.", key: true, name: "set", options: ["ttl", "json-value"], value: true },
  { description: "Delete one key.", key: true, name: "del", options: [] },
]

const optionUsage: Record<KVCliOption, string> = {
  "cursor": "[--cursor <cursor>]",
  "json-value": "[--json-value]",
  "limit": "[--limit <n>]",
  "prefix": "[--prefix <prefix>]",
  "ttl": "[--ttl <seconds>]",
}

const optionHelp: Record<KVCliOption, string> = {
  "cursor": "  --cursor <cursor>   Read the page after this cursor. `list` prints the next cursor.",
  "json-value": "  --json-value        Parse the value as JSON. Without it, the value is a string.",
  "limit": `  --limit <n>         Show at most n keys. Defaults to ${kvDevDefaultListLimit}. Maximum ${kvDevMaximumListLimit}.`,
  "prefix": "  --prefix <prefix>   Show only keys that start with this prefix.",
  "ttl": "  --ttl <seconds>     Expire the key after this time. Some drivers ignore TTL or raise it to a minimum.",
}

function commandUsage(command: KVCommand): string {
  const key = command.key ? " <key>" : ""
  const value = command.value ? " <value|@file>" : ""
  const options = command.options.map(option => ` ${optionUsage[option]}`).join("")
  return `vitehub kv ${command.name}${key}${value}${options} [--store <name>] [--json] [--url <url>]`
}

function writeUsage(command: KVCommand, stream: ViteHubCliStreams["stdout"]): void {
  stream.write([
    `Usage: ${commandUsage(command)}`,
    "",
    command.description,
    "The command calls the KV runtime of a running Vite + Nitro Development Server.",
    ...(command.value ? ["A value that starts with @ names a UTF-8 file. The path is relative to the current directory."] : []),
    "",
    "Options:",
    ...command.options.map(option => optionHelp[option]),
    "  --store <name>      KV store. Defaults to `default`.",
    "  --json              Print JSON.",
    "  --url <url>         Compatible Vite Development Server URL. Defaults to http://localhost:5173.",
    "  --timeout <ms>      Request timeout.",
    "  -h, --help          Show this help.",
    "",
  ].join("\n"))
}

function parsePositiveInteger(name: string, value: string | undefined): number {
  const number = Number(value)
  if (!value || !Number.isInteger(number) || number < 1) {
    throw kvErrorDiagnostics.KV_R0019({ message: `--${name} must be a positive integer.` })
  }
  return number
}

function readOptionValue(args: readonly string[], index: number, name: string): { consumed: number, value: string } | undefined {
  const arg = args[index]!
  if (arg === `--${name}`) {
    const value = args[index + 1]
    if (value === undefined || value.startsWith("--")) throw kvErrorDiagnostics.KV_R0019({ message: `--${name} needs a value.` })
    return { consumed: 1, value }
  }
  if (arg.startsWith(`--${name}=`)) return { consumed: 0, value: arg.slice(name.length + 3) }
}

function parseArgs(command: KVCommand, args: readonly string[], env: NodeJS.ProcessEnv): ParsedKVArgs {
  const parsed: ParsedKVArgs = { help: false, json: false, jsonValue: false, url: resolveViteHubDevServerUrl(env) }
  const positionals: string[] = []
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
    if (arg === "--json-value" && command.options.includes("json-value")) {
      parsed.jsonValue = true
      continue
    }
    if (arg === "--") {
      positionals.push(...args.slice(index + 1))
      break
    }
    const targetOption = readViteHubDevTargetOption(args, index, parsed, kvDevTargetErrors)
    if (targetOption !== undefined) {
      index += targetOption
      continue
    }
    const store = readOptionValue(args, index, "store")
    if (store) {
      parsed.store = store.value
      index += store.consumed
      continue
    }
    let matched = false
    for (const option of ["cursor", "limit", "prefix", "ttl"] as const) {
      if (!command.options.includes(option)) continue
      const read = readOptionValue(args, index, option)
      if (!read) continue
      if (option === "limit" || option === "ttl") parsed[option] = parsePositiveInteger(option, read.value)
      else parsed[option] = read.value
      index += read.consumed
      matched = true
      break
    }
    if (matched) continue
    if (arg.startsWith("-")) throw kvErrorDiagnostics.KV_R0019({ message: `Unknown option: ${arg}.` })
    positionals.push(arg)
  }
  const expected = (command.key ? 1 : 0) + (command.value ? 1 : 0)
  if (positionals.length > expected) throw kvErrorDiagnostics.KV_R0019({ message: `Unexpected argument: ${positionals[expected]}.` })
  if (command.key) parsed.key = positionals[0]
  if (command.value) parsed.value = positionals[1]
  if (!parsed.help && command.key && !parsed.key) throw kvErrorDiagnostics.KV_R0019({ message: "Missing key." })
  if (!parsed.help && command.value && parsed.value === undefined) throw kvErrorDiagnostics.KV_R0019({ message: "Missing value." })
  if (parsed.limit !== undefined && parsed.limit > kvDevMaximumListLimit) {
    throw kvErrorDiagnostics.KV_R0019({ message: `--limit must be at most ${kvDevMaximumListLimit}.` })
  }
  return parsed
}

async function readValue(parsed: ParsedKVArgs, cwd: string): Promise<unknown> {
  const raw = parsed.value!
  const text = raw.startsWith("@") ? await readFile(resolve(cwd, raw.slice(1)), "utf8") : raw
  if (!parsed.jsonValue) return text
  try {
    return JSON.parse(text) as unknown
  }
  catch (error) {
    throw kvErrorDiagnostics.KV_R0019({ message: `The value is not valid JSON: ${error instanceof Error ? error.message : String(error)}` })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isKVDevListResult(value: unknown): value is KVDevListResult {
  return isRecord(value) && Array.isArray(value.keys) && typeof value.limit === "number" && typeof value.prefix === "string" && typeof value.store === "string" && Array.isArray(value.stores)
}

function isKVDevGetResult(value: unknown): value is KVDevGetResult {
  return isRecord(value) && typeof value.found === "boolean" && typeof value.key === "string" && typeof value.store === "string"
}

function formatValue(result: KVDevGetResult): string | Uint8Array {
  if (result.encoding === "base64" && typeof result.value === "string") return Uint8Array.from(atob(result.value), character => character.charCodeAt(0))
  if (typeof result.value === "string") return `${result.value}\n`
  return `${JSON.stringify(result.value, null, 2)}\n`
}

function writeResult(operation: KVDevOperation, result: unknown, context: KVCliContext): number {
  if (!isRecord(result)) return 1
  // SAFETY: the KV dev handler of the same package version writes these shapes.
  switch (operation) {
    case "list": {
      if (!isKVDevListResult(result)) return 1
      const page = result
      // Some drivers scan a fixed number of entries per page, so a page can be empty while more keys exist.
      if (page.keys.length === 0 && page.cursor) context.stdout.write("No keys on this page.\n")
      else if (page.keys.length === 0) context.stdout.write(`No keys${page.prefix ? ` with prefix ${page.prefix}` : ""} in store ${page.store}.\n`)
      else context.stdout.write(`${page.keys.join("\n")}\n`)
      // The cursor hint goes to stderr, so stdout stays a plain key list for scripts.
      if (page.cursor) context.stderr.write(`More keys exist. Next page: --cursor ${page.cursor}\n`)
      return 0
    }
    case "get": {
      if (!isKVDevGetResult(result)) return 1
      const value = result
      if (!value.found) {
        context.stderr.write(`Key ${value.key} was not found in store ${value.store}.\n`)
        return 1
      }
      context.stdout.write(formatValue(value))
      return 0
    }
    case "has": {
      const value = result as unknown as KVDevHasResult
      context.stdout.write(`Key ${value.key} ${value.exists ? "exists" : "does not exist"} in store ${value.store}.\n`)
      return value.exists ? 0 : 1
    }
    case "set": {
      const value = result as unknown as KVDevSetResult
      context.stdout.write([
        `${value.created ? "Created" : "Updated"} key ${value.key} in store ${value.store} (${value.type}${value.ttl ? `, TTL ${value.ttl} s` : ""}).`,
        ...(value.notice ? [value.notice] : []),
        "",
      ].join("\n"))
      return 0
    }
    case "del": {
      const value = result as unknown as KVDevDeleteResult
      context.stdout.write(value.deleted
        ? `Deleted key ${value.key} from store ${value.store}.\n`
        : `Key ${value.key} did not exist in store ${value.store}. Nothing changed.\n`)
      return 0
    }
  }
}

function exitCode(operation: KVDevOperation, result: Record<string, unknown>): number {
  if (operation === "get") return result.found === true ? 0 : 1
  if (operation === "has") return result.exists === true ? 0 : 1
  return 0
}

async function readFailure(response: Response): Promise<KVCliFailure> {
  const text = await response.text()
  try {
    const parsed: unknown = JSON.parse(text)
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return { ...(typeof parsed.error.code === "string" ? { code: parsed.error.code } : {}), message: parsed.error.message }
    }
  }
  catch {
    // Guard rejections use plain text.
  }
  return { message: text || `KV Dev request failed with HTTP ${response.status}.` }
}

function writeFailure(parsed: Pick<ParsedKVArgs, "json">, context: KVCliContext, failure: KVCliFailure): number {
  if (parsed.json) context.stdout.write(`${JSON.stringify({ error: failure }, null, 2)}\n`)
  else context.stderr.write(`${failure.message}\n`)
  return 1
}

function withTimeout(timeout: number | undefined): Pick<RequestInit, "signal"> {
  return timeout ? { signal: AbortSignal.timeout(timeout) } : {}
}

async function runKVCommand(command: KVCommand, args: string[], context: KVCliContext, options: KVCliOptions): Promise<number> {
  let parsed: ParsedKVArgs
  let value: unknown
  try {
    parsed = parseArgs(command, args, context.env)
    if (command.value && !parsed.help) value = await readValue(parsed, context.cwd)
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
  const server = await discoverViteHubDevServer<KVDevDiscovery>({
    endpoint: kvDevEndpoint,
    fetch: fetchImpl,
    rootDir: context.rootDir,
    serverUrl: parsed.url,
    stderr: context.stderr,
  })
  if (!server) {
    context.stderr.write(`${kvDevServerHint}\n`)
    return 1
  }
  if (server.discovery.runtime !== "nitro") {
    return writeFailure(parsed, context, {
      code: "KV_DEV_RUNTIME_UNAVAILABLE",
      message: typeof server.discovery.message === "string"
        ? server.discovery.message
        : "This Vite Development Server cannot reach the KV runtime.",
    })
  }
  const body: KVDevRequestBody = {
    ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
    ...(parsed.key !== undefined ? { key: parsed.key } : {}),
    ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
    operation: command.name,
    ...(parsed.prefix !== undefined ? { prefix: parsed.prefix } : {}),
    ...(parsed.store !== undefined ? { store: parsed.store } : {}),
    ...(parsed.ttl !== undefined ? { ttl: parsed.ttl } : {}),
    ...(command.value ? { value } : {}),
  }
  let response: Response
  try {
    response = await fetchViteHubDevEndpoint(fetchImpl, server.url, kvDevEndpoint, {
      body: JSON.stringify(body),
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      ...withTimeout(parsed.timeout),
    })
  }
  catch (error) {
    return writeFailure(parsed, context, { message: `KV Dev request failed: ${error instanceof Error ? error.message : String(error)}` })
  }
  if (!response.ok) return writeFailure(parsed, context, await readFailure(response))
  const result: unknown = await response.json().catch(() => undefined)
  if (!isRecord(result)) return writeFailure(parsed, context, { message: "The KV Dev response is not valid JSON." })
  if (!parsed.json) return writeResult(command.name, result, context)
  context.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return exitCode(command.name, result)
}

/**
 * Runs one `vitehub kv` command against a running Vite + Nitro Development Server.
 * `args[0]` is the command name, for example `list` or `set`.
 */
export async function runKVCli(args: string[], context: KVCliContext, options: KVCliOptions = {}): Promise<number> {
  const [name, ...rest] = args
  const command = kvCommands.find(entry => entry.name === name)
  if (!command) {
    context.stderr.write(`${name ? `Unknown kv command: ${name}\n` : ""}Commands: ${kvCommands.map(entry => entry.name).join(", ")}\n`)
    return 1
  }
  return await runKVCommand(command, rest, context, options)
}

export function createKVCliContributor(options: KVCliOptions = {}): ViteHubCliContributor {
  return {
    namespaces: [{
      description: "Read and write keys of the KV stores in a running Vite + Nitro Development Server.",
      features: kvCommands.map(command => ({
        description: command.description,
        name: command.name,
        run: async (args: string[], context: ViteHubCliContext) => await runKVCommand(command, args, context, options),
        usage: commandUsage(command),
      })),
      name: "kv",
    }],
  }
}
