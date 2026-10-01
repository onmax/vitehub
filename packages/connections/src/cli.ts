import { createServer } from "node:http"

import { CONNECTIONS_ROUTE } from "./route.ts"

import type { ViteHubCliContext, ViteHubCliContributor, ViteHubCliFeature } from "@vite-hub/internal/cli"
import type { ConnectionApproval, ConnectionApprovalPage, ConnectionInspection } from "./types.ts"

type CliContext = Pick<ViteHubCliContext, "env" | "stderr" | "stdout">

export interface ConnectionsCliOptions {
  fetch?: typeof fetch
  /** Seconds to wait for the loopback callback. Defaults to 300. */
  timeout?: number
}

interface ParsedArgs {
  confirm?: string
  flags: Map<string, string | true>
  json: boolean
  positionals: string[]
  url: string
}

class CliError extends Error {}

const valueFlags = new Set(["--before", "--confirm", "--name", "--port", "--status", "--url"])

function parse(args: string[], env: NodeJS.ProcessEnv): ParsedArgs {
  const flags = new Map<string, string | true>()
  const positionals: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (!argument.startsWith("-")) {
      positionals.push(argument)
      continue
    }
    const [flag, inline] = argument.split(/=(.*)/s, 2) as [string, string | undefined]
    if (flag === "-h" || flag === "--help" || flag === "--json") {
      flags.set(flag === "-h" ? "--help" : flag, true)
      continue
    }
    if (!valueFlags.has(flag)) throw new CliError(`Unknown option: ${flag}.`)
    const value = inline ?? args[index + 1]
    if (!value || (inline === undefined && value.startsWith("-"))) throw new CliError(`Missing value for ${flag}.`)
    if (inline === undefined) index += 1
    flags.set(flag, value)
  }
  const url = flags.get("--url")
  return {
    confirm: typeof flags.get("--confirm") === "string" ? flags.get("--confirm") as string : undefined,
    flags,
    json: flags.has("--json"),
    positionals,
    url: typeof url === "string" ? url : env.VITEHUB_CONNECTIONS_URL || "http://localhost:5173",
  }
}

function flag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name)
  return typeof value === "string" ? value : undefined
}

function appUrl(parsed: ParsedArgs): URL {
  let url: URL
  try {
    url = new URL(parsed.url)
  }
  catch {
    throw new CliError(`Invalid --url: ${parsed.url}.`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new CliError("--url must use http or https.")
  return url
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
}

async function request<T>(parsed: ParsedArgs, options: ConnectionsCliOptions, body: Record<string, unknown>): Promise<T> {
  const base = appUrl(parsed)
  const endpoint = new URL(CONNECTIONS_ROUTE, base)
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(endpoint, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", origin: base.origin },
      method: "POST",
    })
  }
  catch {
    throw new CliError(`Could not reach ${endpoint.origin}. Start the development server, or pass --url.`)
  }
  const text = await response.text()
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch {
    throw new CliError(`${endpoint.href} returned ${response.status} without a Connections response. Check that the app uses Connections and that the management API is mounted.`)
  }
  if (!response.ok) {
    const error = (value as { error?: { code?: unknown, message?: unknown } }).error
    throw new CliError(`${typeof error?.message === "string" ? error.message : `Request failed with ${response.status}.`}${typeof error?.code === "string" ? ` (${error.code})` : ""}`)
  }
  return value as T
}

function write(context: CliContext, parsed: ParsedArgs, value: unknown, text: () => string): void {
  context.stdout.write(parsed.json ? `${JSON.stringify(value, null, 2)}\n` : `${text()}\n`)
}

function describeConnection(connection: ConnectionInspection): string {
  const lines = [
    `${connection.name}  ${connection.provider}  ${connection.status}${connection.account?.email ? `  ${connection.account.email}` : ""}`,
  ]
  if (connection.scopes.missing.length) lines.push(`  missing scopes: ${connection.scopes.missing.join(" ")}`)
  return lines.join("\n")
}

function describeApproval(approval: ConnectionApproval): string {
  return `${approval.id}  ${approval.status}  ${approval.name}  ${approval.action}  ${approval.actor}  ${approval.createdAt}`
}

function requireName(parsed: ParsedArgs, command: string): string {
  const name = parsed.positionals[0]
  if (!name) throw new CliError(`${command} requires a Connection name.`)
  return name
}

function port(parsed: ParsedArgs): number {
  const value = flag(parsed, "--port")
  if (value === undefined) return 0
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 1 || result > 65_535) throw new CliError("--port requires a TCP port.")
  return result
}

async function connectLoopback(name: string, parsed: ParsedArgs, context: CliContext, options: ConnectionsCliOptions): Promise<ConnectionInspection> {
  let resolveCallback!: (value: { code: string, state: string }) => void
  let rejectCallback!: (error: Error) => void
  const callback = new Promise<{ code: string, state: string }>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })
  let expectedState: string | undefined
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== "/callback") {
      outgoing.writeHead(404).end()
      return
    }
    const state = url.searchParams.get("state")
    const code = url.searchParams.get("code")
    const done = (status: number, message: string) => outgoing.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(`${message}\n`)
    if (url.searchParams.get("error")) {
      done(400, "The provider did not grant access. You can close this tab.")
      rejectCallback(new CliError("The provider did not grant access."))
      return
    }
    if (!state || !code || state !== expectedState) {
      done(400, "The authorization response does not match this request.")
      return
    }
    done(200, "Authorization received. You can close this tab and return to the terminal.")
    resolveCallback({ code, state })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port(parsed), "127.0.0.1", () => resolve())
  })
  const timeout = setTimeout(() => rejectCallback(new CliError("Timed out while waiting for the authorization callback.")), (options.timeout ?? 300) * 1_000)
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new CliError("Could not start the loopback callback server.")
    const redirectUri = `http://127.0.0.1:${address.port}/callback`
    const authorization = await request<{ state: string, url: string }>(parsed, options, { action: "authorize", name, redirectUri })
    expectedState = authorization.state
    context.stderr.write(`Open this URL to connect "${name}":\n\n  ${authorization.url}\n\nWaiting for ${redirectUri} ...\n`)
    const result = await callback
    return (await request<{ connection: ConnectionInspection }>(parsed, options, { action: "complete", ...result })).connection
  }
  finally {
    clearTimeout(timeout)
    server.close()
  }
}

type Command = (parsed: ParsedArgs, context: CliContext, options: ConnectionsCliOptions) => Promise<number | void>

const commands: Record<string, { description: string, run: Command, usage: string }> = {
  list: {
    description: "List Connections and their status.",
    usage: "vitehub connections list [--url <app>] [--json]",
    async run(parsed, context, options) {
      const { connections } = await request<{ connections: ConnectionInspection[] }>(parsed, options, { action: "list" })
      write(context, parsed, connections, () => connections.length ? connections.map(describeConnection).join("\n") : "No Connections found.")
    },
  },
  inspect: {
    description: "Show one Connection: account, scopes, and actions.",
    usage: "vitehub connections inspect <name> [--url <app>] [--json]",
    async run(parsed, context, options) {
      const { connection } = await request<{ connection: ConnectionInspection }>(parsed, options, { action: "inspect", name: requireName(parsed, "inspect") })
      write(context, parsed, connection, () => [
        describeConnection(connection),
        `  granted scopes: ${connection.scopes.granted.join(" ") || "none"}`,
        ...connection.actions.map(action => `  ${action.write ? "write" : "read "}  ${action.id}${action.highRisk ? "  high risk" : ""}`),
      ].join("\n"))
    },
  },
  connect: {
    description: "Grant access to a Connection with the provider OAuth flow.",
    usage: "vitehub connections connect <name> [--url <app>] [--port <port>] [--json]",
    async run(parsed, context, options) {
      const name = requireName(parsed, "connect")
      const base = appUrl(parsed)
      if (!isLoopback(base)) {
        const url = new URL(`${CONNECTIONS_ROUTE}/connect/${encodeURIComponent(name)}`, base)
        write(context, parsed, { url: url.href }, () => `Open this URL while signed in to the Console:\n\n  ${url.href}`)
        return
      }
      const connection = await connectLoopback(name, parsed, context, options)
      write(context, parsed, connection, () => `Connected. ${describeConnection(connection)}`)
    },
  },
  activity: {
    description: "Show audited calls, refreshes, and denials for a Connection.",
    usage: "vitehub connections activity <name> [--before <id>] [--url <app>] [--json]",
    async run(parsed, context, options) {
      const before = flag(parsed, "--before")
      const { activity } = await request<{ activity: Array<{ action: string, actor: { id: string, kind: string }, id: string, operation?: string, outcome: string, timestamp: string }> }>(parsed, options, {
        action: "activity",
        name: requireName(parsed, "activity"),
        ...(before ? { before } : {}),
      })
      write(context, parsed, activity, () => activity.length
        ? activity.map(entry => `${entry.timestamp}  ${entry.outcome}  ${entry.action}${entry.operation ? `  ${entry.operation}` : ""}  ${entry.actor.kind}:${entry.actor.id}  ${entry.id}`).join("\n")
        : "No activity.")
    },
  },
  approvals: {
    description: "List, approve, or deny writes that wait for approval.",
    usage: "vitehub connections approvals [approve|deny <id>] [--name <name>] [--status <status>] [--before <cursor>] [--url <app>] [--json]",
    async run(parsed, context, options) {
      const [subcommand, id] = parsed.positionals
      if (subcommand === "approve" || subcommand === "deny") {
        if (!id) throw new CliError(`approvals ${subcommand} requires an approval id.`)
        if (subcommand === "approve") {
          const result = await request<{ approval: ConnectionApproval, result?: unknown }>(parsed, options, { action: "approve", id })
          write(context, parsed, result, () => describeApproval(result.approval))
          return result.approval.status === "failed" ? 1 : undefined
        }
        const result = await request<{ approval: ConnectionApproval }>(parsed, options, { action: "deny", id })
        write(context, parsed, result, () => describeApproval(result.approval))
        return
      }
      if (subcommand) throw new CliError(`Unknown approvals command: ${subcommand}.`)
      const name = flag(parsed, "--name")
      const before = flag(parsed, "--before")
      const page = await request<ConnectionApprovalPage>(parsed, options, {
        action: "approvals",
        ...(before ? { before } : {}),
        ...(name ? { name } : {}),
        status: flag(parsed, "--status") ?? "pending",
      })
      write(context, parsed, page, () => [
        page.approvals.length ? page.approvals.map(describeApproval).join("\n") : "No approvals.",
        ...(page.nextCursor ? [`Next page: repeat this command with --before ${page.nextCursor}.`] : []),
      ].join("\n"))
    },
  },
  revoke: {
    description: "Revoke the provider grant and delete the stored token.",
    usage: "vitehub connections revoke <name> --confirm <name> [--url <app>] [--json]",
    async run(parsed, context, options) {
      const name = requireName(parsed, "revoke")
      if (parsed.confirm !== name) throw new CliError(`Pass --confirm ${name} to revoke this Connection.`)
      const { connection } = await request<{ connection: ConnectionInspection }>(parsed, options, { action: "revoke", name })
      write(context, parsed, connection, () => `Revoked. ${describeConnection(connection)}`)
    },
  },
}

function usage(): string {
  return [
    "Usage: vitehub connections <command> [options]",
    "",
    "Manage Connections through the app management API.",
    "",
    ...Object.values(commands).map(command => `  ${command.usage}`),
    "",
    "Options:",
    "  --url <url>   App origin. Defaults to VITEHUB_CONNECTIONS_URL or http://localhost:5173.",
    "  --port <port> Loopback callback port for connect. The OAuth client must allow http://127.0.0.1:<port>/callback.",
    "  --before <id> Read older activity or approval pages.",
    "  --json        Print JSON. Approval lists return { approvals, nextCursor? }.",
    "",
  ].join("\n")
}

/** Run one Connections CLI command. */
export async function runConnectionsCli(command: string, args: string[], context: CliContext, options: ConnectionsCliOptions = {}): Promise<number> {
  try {
    const parsed = parse(args, context.env)
    const entry = commands[command]
    if (!entry || parsed.flags.has("--help")) {
      context.stdout.write(usage())
      return entry ? 0 : 1
    }
    return (await entry.run(parsed, context, options)) ?? 0
  }
  catch (error) {
    context.stderr.write(`${error instanceof CliError ? error.message : error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/** CLI namespace that `vitehub connections` uses. */
export function createConnectionsCliContributor(options: ConnectionsCliOptions = {}): ViteHubCliContributor {
  const features: ViteHubCliFeature[] = Object.entries(commands).map(([name, command]) => ({
    description: command.description,
    name,
    run: (args, context) => runConnectionsCli(name, args, context, options),
    usage: command.usage,
  }))
  return {
    namespaces: [{ description: "Manage OAuth Connections, approvals, and activity.", features, name: "connections" }],
  }
}
