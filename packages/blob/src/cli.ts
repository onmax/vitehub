import { readFile, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
  discoverViteHubDevServer,
  fetchViteHubDevEndpoint,
  readViteHubDevTargetOption,
  resolveViteHubDevServerUrl,
} from "@vite-hub/internal/cli"

import {
  blobDevDefaultListLimit,
  blobDevFileHeader,
  blobDevHeader,
  blobDevHeaderValue,
  blobDevMaximumListLimit,
  blobDevMaximumUploadBytes,
  blobDevRoute,
} from "./dev.ts"
import { blobErrorDiagnostics } from "./error-diagnostics.ts"

import type { ViteHubCliContext, ViteHubCliContributor, ViteHubCliStreams } from "@vite-hub/internal/cli"
import type { BlobDevFileHeader, BlobDevOperation, BlobDevRequestBody } from "./dev.ts"
import type { BlobDevDeleteResult, BlobDevHeadResult, BlobDevListResult, BlobDevObject, BlobDevPutResult } from "./runtime/dev.ts"

export type BlobCliContext = Pick<ViteHubCliContext, "cwd" | "env" | "rootDir"> & ViteHubCliStreams

export interface BlobCliOptions {
  fetch?: typeof fetch
}

type BlobCliOption = "content-type" | "cursor" | "limit" | "output" | "prefix"

interface BlobCommand {
  description: string
  file?: boolean
  name: BlobDevOperation
  options: readonly BlobCliOption[]
  pathname: boolean
}

interface ParsedBlobArgs {
  contentType?: string
  cursor?: string
  file?: string
  help: boolean
  json: boolean
  limit?: number
  output?: string
  pathname?: string
  prefix?: string
  store?: string
  timeout?: number
  url: string
}

interface BlobDevDiscovery {
  message?: unknown
  root?: unknown
  runtime?: unknown
}

interface BlobCliFailure {
  code?: string
  message: string
}

const blobDevEndpoint = {
  header: blobDevHeader,
  headerValue: blobDevHeaderValue,
  route: blobDevRoute,
}

const blobDevTargetErrors = {
  invalidInlineTimeout: (message: string) => blobErrorDiagnostics.BLOB_R0029({ message }),
  invalidTimeout: (message: string) => blobErrorDiagnostics.BLOB_R0029({ message }),
  missingValue: (message: string) => blobErrorDiagnostics.BLOB_R0029({ message }),
}

// Nuxt mounts Vite under `/_nuxt/`, so the Blob dev endpoint is not reachable there.
const blobDevServerHint = "`vitehub blob` needs a running Vite + Nitro Development Server with `blob` enabled. Nuxt and plain Vite are not supported."

const blobCommands: readonly BlobCommand[] = [
  { description: "List blobs of a Blob store, one page at a time.", name: "list", options: ["prefix", "limit", "cursor"], pathname: false },
  { description: "Show the metadata of one blob.", name: "head", options: [], pathname: true },
  { description: "Download one blob to a file, or to stdout without --output.", name: "get", options: ["output"], pathname: true },
  { description: "Upload one file as a blob.", file: true, name: "put", options: ["content-type"], pathname: true },
  { description: "Delete one blob.", name: "del", options: [], pathname: true },
]

const optionUsage: Record<BlobCliOption, string> = {
  "content-type": "[--content-type <type>]",
  "cursor": "[--cursor <cursor>]",
  "limit": "[--limit <n>]",
  "output": "[--output <file>]",
  "prefix": "[--prefix <prefix>]",
}

const optionHelp: Record<BlobCliOption, string> = {
  "content-type": "  --content-type <t>  Content type of the blob. Without it, the storage detects the type from the pathname.",
  "cursor": "  --cursor <cursor>   Read the page after this cursor. `list` prints the next cursor.",
  "limit": `  --limit <n>         Show at most n blobs. Defaults to ${blobDevDefaultListLimit}. Maximum ${blobDevMaximumListLimit}.`,
  "output": "  --output <file>     Write the blob to this file. Without it, the bytes go to stdout.",
  "prefix": "  --prefix <prefix>   Show only blobs whose pathname starts with this prefix.",
}

function commandUsage(command: BlobCommand): string {
  const pathname = command.pathname ? " <pathname>" : ""
  const file = command.file ? " <file>" : ""
  const options = command.options.map(option => ` ${optionUsage[option]}`).join("")
  return `vitehub blob ${command.name}${pathname}${file}${options} [--store <name>] [--json] [--url <url>]`
}

function writeUsage(command: BlobCommand, stream: ViteHubCliStreams["stdout"]): void {
  stream.write([
    `Usage: ${commandUsage(command)}`,
    "",
    command.description,
    "The command calls the Blob runtime of a running Vite + Nitro Development Server.",
    ...(command.file ? [`The file path is relative to the current directory. The dev endpoint accepts files up to ${blobDevMaximumUploadBytes} bytes (8 MiB).`] : []),
    ...(command.name === "get" ? ["--json needs --output, because stdout carries the file bytes otherwise."] : []),
    "",
    "Options:",
    ...command.options.map(option => optionHelp[option]),
    "  --store <name>      Blob store. Defaults to `default`.",
    "  --json              Print JSON.",
    "  --url <url>         Compatible Vite Development Server URL. Defaults to http://localhost:5173.",
    "  --timeout <ms>      Request timeout.",
    "  -h, --help          Show this help.",
    "",
  ].join("\n"))
}

function parsePositiveInteger(name: string, value: string): number {
  const number = Number(value)
  if (!value || !Number.isInteger(number) || number < 1) {
    throw blobErrorDiagnostics.BLOB_R0029({ message: `--${name} must be a positive integer.` })
  }
  return number
}

function readOptionValue(args: readonly string[], index: number, name: string): { consumed: number, value: string } | undefined {
  const arg = args[index]!
  if (arg === `--${name}`) {
    const value = args[index + 1]
    if (value === undefined || value.startsWith("--")) throw blobErrorDiagnostics.BLOB_R0029({ message: `--${name} needs a value.` })
    return { consumed: 1, value }
  }
  if (arg.startsWith(`--${name}=`)) return { consumed: 0, value: arg.slice(name.length + 3) }
}

function parseArgs(command: BlobCommand, args: readonly string[], env: NodeJS.ProcessEnv): ParsedBlobArgs {
  const parsed: ParsedBlobArgs = { help: false, json: false, url: resolveViteHubDevServerUrl(env) }
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
    if (arg === "--") {
      positionals.push(...args.slice(index + 1))
      break
    }
    const targetOption = readViteHubDevTargetOption(args, index, parsed, blobDevTargetErrors)
    if (targetOption !== undefined) {
      index += targetOption
      continue
    }
    const store = readOptionValue(args, index, "store")
    if (store) {
      if (!store.value.trim()) throw blobErrorDiagnostics.BLOB_R0029({ message: "--store needs a nonempty name." })
      parsed.store = store.value
      index += store.consumed
      continue
    }
    let matched = false
    for (const option of command.options) {
      const read = readOptionValue(args, index, option)
      if (!read) continue
      if (option === "limit") parsed.limit = parsePositiveInteger(option, read.value)
      else if (option === "content-type") parsed.contentType = read.value
      else parsed[option] = read.value
      index += read.consumed
      matched = true
      break
    }
    if (matched) continue
    if (arg.startsWith("-")) throw blobErrorDiagnostics.BLOB_R0029({ message: `Unknown option: ${arg}.` })
    positionals.push(arg)
  }
  const expected = (command.pathname ? 1 : 0) + (command.file ? 1 : 0)
  if (positionals.length > expected) throw blobErrorDiagnostics.BLOB_R0029({ message: `Unexpected argument: ${positionals[expected]}.` })
  if (command.pathname) parsed.pathname = positionals[0]
  if (command.file) parsed.file = positionals[1]
  if (parsed.help) return parsed
  if (command.pathname && !parsed.pathname) throw blobErrorDiagnostics.BLOB_R0029({ message: "Missing pathname." })
  if (command.file && !parsed.file) throw blobErrorDiagnostics.BLOB_R0029({ message: "Missing file." })
  if (parsed.limit !== undefined && parsed.limit > blobDevMaximumListLimit) {
    throw blobErrorDiagnostics.BLOB_R0029({ message: `--limit must be at most ${blobDevMaximumListLimit}.` })
  }
  if (command.name === "get" && parsed.json && !parsed.output) {
    throw blobErrorDiagnostics.BLOB_R0029({ message: "--json needs --output, because stdout carries the file bytes otherwise." })
  }
  return parsed
}

/** Reads the upload file. The size check runs before the read, so a large file is not loaded. */
async function readUpload(path: string): Promise<{ data: string } | BlobCliFailure> {
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) return { message: `File not found: ${path}` }
  if (info.size > blobDevMaximumUploadBytes) {
    return {
      code: "BLOB_DEV_UPLOAD_TOO_LARGE",
      message: `The file is ${info.size} bytes. \`vitehub blob put\` accepts at most ${blobDevMaximumUploadBytes} bytes (8 MiB), because the dev endpoint sends the file as base64 JSON.`,
    }
  }
  try {
    return { data: (await readFile(path)).toString("base64") }
  }
  catch (error) {
    return { message: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function formatSize(size: number | undefined): string {
  return size === undefined ? "-" : `${size} B`
}

function formatTable(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  return rows.map(row => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  ")).join("\n")
}

function formatMetadata(value: Record<string, unknown>): string | undefined {
  const entries = Object.entries(value)
  return entries.length ? entries.map(([name, entry]) => `${name}=${String(entry)}`).join(", ") : undefined
}

function formatObject(object: BlobDevObject, store: string): string {
  const rows: [string, string | undefined][] = [
    ["Pathname", object.pathname],
    ["Store", store],
    ["Size", formatSize(object.size)],
    ["Content type", object.contentType],
    ["ETag", object.httpEtag],
    ["Uploaded", object.uploadedAt],
    ["HTTP metadata", formatMetadata(object.httpMetadata)],
    ["Custom metadata", formatMetadata(object.customMetadata)],
  ]
  const present = rows.filter((row): row is [string, string] => row[1] !== undefined)
  return `${formatTable(present)}\n`
}

type BlobCliResult =
  | { operation: "list", value: BlobDevListResult }
  | { operation: "head", value: BlobDevHeadResult }
  | { operation: "put", value: BlobDevPutResult }
  | { operation: "del", value: BlobDevDeleteResult }

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string")
}

function isBlobObject(value: unknown): value is BlobDevObject {
  return isRecord(value) && typeof value.pathname === "string" && typeof value.uploadedAt === "string"
    && isRecord(value.customMetadata) && isRecord(value.httpMetadata)
    && (value.size === undefined || (typeof value.size === "number" && Number.isFinite(value.size)))
    && (value.contentType === undefined || typeof value.contentType === "string")
    && (value.httpEtag === undefined || typeof value.httpEtag === "string")
    && (value.urlAvailable === undefined || value.urlAvailable === true)
}

function parseResult(operation: Exclude<BlobDevOperation, "get">, value: unknown): BlobCliResult | undefined {
  if (!isRecord(value) || typeof value.store !== "string") return undefined
  if (operation === "del") {
    return typeof value.deleted === "boolean" && typeof value.pathname === "string"
      ? { operation, value: { deleted: value.deleted, pathname: value.pathname, store: value.store } } : undefined
  }
  if (operation === "list") {
    if (!Array.isArray(value.blobs) || !value.blobs.every(isBlobObject) || typeof value.hasMore !== "boolean"
      || typeof value.limit !== "number" || !Number.isFinite(value.limit) || typeof value.prefix !== "string"
      || !isStrings(value.stores) || (value.cursor !== undefined && typeof value.cursor !== "string")) return undefined
    return { operation, value: {
      blobs: value.blobs, hasMore: value.hasMore, limit: value.limit, prefix: value.prefix, store: value.store, stores: value.stores,
      ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
    } }
  }
  if (!isBlobObject(value.object)) return undefined
  if (operation === "head") return { operation, value: { object: value.object, store: value.store } }
  return typeof value.created === "boolean" ? { operation, value: { created: value.created, object: value.object, store: value.store } } : undefined
}

function writeResult(result: BlobCliResult, context: BlobCliContext): void {
  switch (result.operation) {
    case "list": {
      const page = result.value
      if (page.blobs.length === 0 && page.cursor) context.stdout.write("No blobs on this page.\n")
      else if (page.blobs.length === 0) context.stdout.write(`No blobs${page.prefix ? ` with prefix ${page.prefix}` : ""} in store ${page.store}.\n`)
      else {
        context.stdout.write(`${formatTable([
          ["PATHNAME", "SIZE", "CONTENT TYPE", "UPLOADED"],
          ...page.blobs.map(object => [object.pathname, formatSize(object.size), object.contentType ?? "-", object.uploadedAt]),
        ])}\n`)
      }
      // The cursor hint goes to stderr, so stdout stays a plain table for scripts.
      if (page.cursor) context.stderr.write(`More blobs exist. Next page: --cursor ${page.cursor}\n`)
      else if (page.hasMore) context.stderr.write("More blobs exist, but the provider returned no cursor.\n")
      return
    }
    case "head": {
      const value = result.value
      context.stdout.write(formatObject(value.object, value.store))
      return
    }
    case "put": {
      const value = result.value
      const details = [formatSize(value.object.size), value.object.contentType].filter(Boolean).join(", ")
      context.stdout.write(`${value.created ? "Created" : "Replaced"} blob ${value.object.pathname} in store ${value.store} (${details}).\n`)
      return
    }
    case "del": {
      const value = result.value
      context.stdout.write(value.deleted
        ? `Deleted blob ${value.pathname} from store ${value.store}.\n`
        : `Blob ${value.pathname} did not exist in store ${value.store}. Nothing changed.\n`)
    }
  }
}

async function readFailure(response: Response): Promise<BlobCliFailure> {
  const text = await response.text()
  try {
    const body: unknown = JSON.parse(text)
    if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
      return { ...(typeof body.error.code === "string" ? { code: body.error.code } : {}), message: body.error.message }
    }
  }
  catch {
    // Guard rejections use plain text.
  }
  return { message: text || `Blob Dev request failed with HTTP ${response.status}.` }
}

function writeFailure(parsed: Pick<ParsedBlobArgs, "json">, context: BlobCliContext, failure: BlobCliFailure): number {
  if (parsed.json) context.stdout.write(`${JSON.stringify({ error: failure }, null, 2)}\n`)
  else context.stderr.write(`${failure.message}\n`)
  return 1
}

function withTimeout(timeout: number | undefined): Pick<RequestInit, "signal"> {
  return timeout ? { signal: AbortSignal.timeout(timeout) } : {}
}

function readFileHeader(response: Response, fallback: { pathname: string, store: string }, size: number): BlobDevFileHeader {
  const raw = response.headers.get(blobDevFileHeader)
  try {
    const header: unknown = raw ? JSON.parse(decodeURIComponent(raw)) : undefined
    if (isRecord(header) && typeof header.pathname === "string" && typeof header.store === "string") {
      return {
        ...(typeof header.contentType === "string" ? { contentType: header.contentType } : {}),
        pathname: header.pathname,
        size,
        store: header.store,
      }
    }
  }
  catch {
    // A missing or damaged header only removes the metadata. The bytes are still correct.
  }
  return { ...fallback, size }
}

async function writeDownload(response: Response, parsed: ParsedBlobArgs, context: BlobCliContext): Promise<number> {
  const bytes = new Uint8Array(await response.arrayBuffer())
  const header = readFileHeader(response, { pathname: parsed.pathname!, store: parsed.store ?? "default" }, bytes.byteLength)
  if (!parsed.output) {
    context.stdout.write(bytes)
    return 0
  }
  const output = resolve(context.cwd, parsed.output)
  try {
    await writeFile(output, bytes)
  }
  catch (error) {
    return writeFailure(parsed, context, { message: `Could not write ${output}: ${error instanceof Error ? error.message : String(error)}` })
  }
  if (parsed.json) context.stdout.write(`${JSON.stringify({ ...header, output }, null, 2)}\n`)
  else context.stdout.write(`Wrote blob ${header.pathname} from store ${header.store} to ${output} (${formatSize(header.size)}).\n`)
  return 0
}

async function runBlobCommand(command: BlobCommand, args: string[], context: BlobCliContext, options: BlobCliOptions): Promise<number> {
  let parsed: ParsedBlobArgs
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
  let data: string | undefined
  if (command.file) {
    const upload = await readUpload(resolve(context.cwd, parsed.file!))
    if (!("data" in upload)) return writeFailure(parsed, context, upload)
    data = upload.data
  }
  const fetchImpl = options.fetch ?? globalThis.fetch
  let discoveryError = ""
  const server = await discoverViteHubDevServer<BlobDevDiscovery>({
    endpoint: blobDevEndpoint,
    fetch: fetchImpl,
    rootDir: context.rootDir,
    serverUrl: parsed.url,
    ...withTimeout(parsed.timeout),
    stderr: parsed.json ? { write: (chunk) => { discoveryError += chunk; return true } } : context.stderr,
  })
  if (!server) {
    if (parsed.json) return writeFailure(parsed, context, { message: `${discoveryError.trim()} ${blobDevServerHint}` })
    context.stderr.write(`${blobDevServerHint}\n`)
    return 1
  }
  if (server.discovery.runtime !== "nitro") {
    return writeFailure(parsed, context, {
      code: "BLOB_DEV_RUNTIME_UNAVAILABLE",
      message: typeof server.discovery.message === "string"
        ? server.discovery.message
        : "This Vite Development Server cannot reach the Blob runtime.",
    })
  }
  const body: BlobDevRequestBody = {
    ...(parsed.contentType !== undefined ? { contentType: parsed.contentType } : {}),
    ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
    operation: command.name,
    ...(parsed.pathname !== undefined ? { pathname: parsed.pathname } : {}),
    ...(parsed.prefix !== undefined ? { prefix: parsed.prefix } : {}),
    ...(parsed.store !== undefined ? { store: parsed.store } : {}),
  }
  let response: Response
  try {
    response = await fetchViteHubDevEndpoint(fetchImpl, server.url, blobDevEndpoint, {
      body: JSON.stringify(body),
      headers: { accept: command.name === "get" ? "application/octet-stream" : "application/json", "content-type": "application/json" },
      method: "POST",
      ...withTimeout(parsed.timeout),
    })
  }
  catch (error) {
    return writeFailure(parsed, context, { message: `Blob Dev request failed: ${error instanceof Error ? error.message : String(error)}` })
  }
  if (!response.ok) return writeFailure(parsed, context, await readFailure(response))
  if (command.name === "get") return await writeDownload(response, parsed, context)
  const result = parseResult(command.name, await response.json().catch(() => undefined))
  if (!result) return writeFailure(parsed, context, { message: "The Blob Dev response is invalid." })
  if (parsed.json) context.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`)
  else writeResult(result, context)
  return 0
}

/**
 * Runs one `vitehub blob` command against a running Vite + Nitro Development Server.
 * `args[0]` is the command name, for example `list` or `put`.
 */
export async function runBlobCli(args: string[], context: BlobCliContext, options: BlobCliOptions = {}): Promise<number> {
  const [name, ...rest] = args
  const command = blobCommands.find(entry => entry.name === name)
  if (!command) {
    context.stderr.write(`${name ? `Unknown blob command: ${name}\n` : ""}Commands: ${blobCommands.map(entry => entry.name).join(", ")}\n`)
    return 1
  }
  return await runBlobCommand(command, rest, context, options)
}

/** Returns the `blob` CLI namespace. */
export function createBlobCliNamespaces(options: BlobCliOptions = {}): NonNullable<ViteHubCliContributor["namespaces"]> {
  return [{
    description: "Read and write blobs of the Blob stores in a running Vite + Nitro Development Server.",
    features: blobCommands.map(command => ({
      description: command.description,
      name: command.name,
      run: async (args: string[], context: ViteHubCliContext) => await runBlobCommand(command, args, context, options),
      usage: commandUsage(command),
    })),
    name: "blob",
  }]
}
