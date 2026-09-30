import { afterEach, describe, expect, it, vi } from "vitest"

import { Readable } from "node:stream"

import { assertKeyTarget, createConnectionsCliContributor, readPipedKey } from "../src/cli.ts"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"
import type { ConnectionActivity, ConnectionSummary } from "../src/types.ts"

const summary: ConnectionSummary = {
  access: {},
  account: "owner@example.com",
  expiresAt: "2026-09-29T12:00:00.000Z",
  kind: "oauth2",
  name: "gmail",
  origins: ["https://*.googleapis.com"],
  provider: "google",
  scopes: [],
  status: "active",
}

function context(env: NodeJS.ProcessEnv = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  const value: ViteHubCliContext = {
    cwd: "/app",
    env,
    rootDir: "/app",
    spawn: async () => ({ exitCode: 0 }),
    stderr: { write: chunk => stderr.push(String(chunk)) },
    stdout: { write: chunk => stdout.push(String(chunk)) },
  }
  return { context: value, stderr, stdout }
}

function stubFetch(response: () => Response) {
  const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response())
  vi.stubGlobal("fetch", fetch)
  return fetch
}

function feature(name: string, readKey?: () => Promise<string>) {
  const [namespace] = createConnectionsCliContributor(readKey ? { readKey } : {}).namespaces
  const found = namespace!.features.find(item => item.name === name)
  if (!found) throw new Error(`Missing feature ${name}.`)
  return found
}

function request(fetch: ReturnType<typeof stubFetch>, index = 0) {
  const [input, init] = fetch.mock.calls[index]!
  return { body: JSON.parse(String(init?.body)) as unknown, headers: new Headers(init?.headers), method: init?.method, url: String(input) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("connections CLI", () => {
  it("lists Connections from the default development server", async () => {
    const fetch = stubFetch(() => Response.json({ connections: [summary, { ...summary, account: undefined, expiresAt: undefined, name: "drive", status: "disconnected" }] }))
    const io = context()

    expect(await feature("list").run([], io.context)).toBe(0)
    expect(request(fetch)).toEqual({
      body: { action: "list" },
      headers: expect.any(Headers),
      method: "POST",
      url: "http://localhost:5173/_vitehub/connections/manage",
    })
    expect(request(fetch).headers.get("origin")).toBe("http://localhost:5173")
    expect(request(fetch).headers.get("content-type")).toBe("application/json")
    expect(io.stdout.join("")).toContain("gmail")
    expect(io.stdout.join("")).toContain("owner@example.com expires 2026-09-29T12:00:00.000Z")
    expect(io.stdout[1]).toMatch(/^drive\s+google\s+disconnected\s+-$/m)
  })

  it("uses --url, --url=, --server, and VITEHUB_DEV_SERVER_URL", async () => {
    const fetch = stubFetch(() => Response.json({ connection: summary }))

    await feature("status").run(["gmail", "--url", "https://dev.example:3000/some/path"], context().context)
    await feature("status").run(["--url=http://127.0.0.1:4000", "gmail"], context().context)
    await feature("status").run(["gmail", "--server", "http://localhost:8080"], context().context)
    await feature("status").run(["gmail"], context({ VITEHUB_DEV_SERVER_URL: "http://localhost:9999" }).context)

    expect(fetch.mock.calls.map((_call, index) => `${request(fetch, index).url} ${request(fetch, index).headers.get("origin")}`)).toEqual([
      "https://dev.example:3000/_vitehub/connections/manage https://dev.example:3000",
      "http://127.0.0.1:4000/_vitehub/connections/manage http://127.0.0.1:4000",
      "http://localhost:8080/_vitehub/connections/manage http://localhost:8080",
      "http://localhost:9999/_vitehub/connections/manage http://localhost:9999",
    ])
    expect(request(fetch).body).toEqual({ action: "inspect", name: "gmail" })
  })

  it("sends the matching action for each command", async () => {
    const fetch = stubFetch(() => Response.json({ connection: summary, events: [], expiresAt: "soon", url: "http://localhost:5173/_vitehub/connections/gmail/connect?ticket=t" }))
    const io = context()

    for (const [name, args] of [["activity", []], ["activity", ["gmail"]], ["connect", ["gmail"]], ["refresh", ["gmail"]], ["disconnect", ["gmail"]]] as const) {
      expect(await feature(name).run([...args], io.context)).toBe(0)
    }

    expect(fetch.mock.calls.map((_call, index) => request(fetch, index).body)).toEqual([
      { action: "activity" },
      { action: "activity", name: "gmail" },
      { action: "start", name: "gmail" },
      { action: "refresh", name: "gmail" },
      { action: "disconnect", name: "gmail" },
    ])
    expect(io.stdout.join("")).toContain("Open this URL in a browser before soon:\nhttp://localhost:5173/_vitehub/connections/gmail/connect?ticket=t\n")
  })

  it("prints activity lines", async () => {
    const event: ConnectionActivity = {
      action: "call",
      actor: { id: "triage", kind: "agent" },
      connection: "gmail",
      durationMs: 12,
      id: "1",
      operation: "gmail.messages.modify",
      outcome: "succeeded",
      status: 200,
      timestamp: "2026-09-29T12:00:00.000Z",
    }
    stubFetch(() => Response.json({ events: [event] }))
    const io = context()

    await feature("activity").run([], io.context)
    expect(io.stdout).toEqual(["2026-09-29T12:00:00.000Z  gmail  agent:triage  call  gmail.messages.modify  succeeded  200  12ms\n"])
  })

  it("returns 1 and prints the server error", async () => {
    stubFetch(() => Response.json({ code: "CONNECTIONS_DENIED", message: "Only Console admins can change Connections." }, { status: 403 }))
    const io = context()

    expect(await feature("connect").run(["gmail"], io.context)).toBe(1)
    expect(io.stderr.join("")).toBe("CONNECTIONS_DENIED: Only Console admins can change Connections.\n")
  })

  it("returns 1 with the status when the error body is not JSON", async () => {
    stubFetch(() => new Response("boom", { status: 502 }))
    const io = context()

    expect(await feature("list").run([], io.context)).toBe(1)
    expect(io.stderr.join("")).toBe("Request failed with 502.\n")
  })

  it("rejects invalid arguments without a request", async () => {
    const fetch = stubFetch(() => Response.json({}))
    for (const [name, args, message] of [
      ["status", [], "vitehub connections status requires a Connection name."],
      ["list", ["--unknown"], "Unknown option: --unknown."],
      ["list", ["--url"], "Missing value for --url."],
      ["status", ["a", "b"], "Unexpected argument: b."],
    ] as const) {
      const io = context()
      expect(await feature(name).run([...args], io.context)).toBe(1)
      expect(io.stderr.join("")).toBe(`${message}\n`)
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it("prints usage for --help", async () => {
    const fetch = stubFetch(() => Response.json({}))
    const io = context()

    expect(await feature("status").run(["--help"], io.context)).toBe(0)
    expect(io.stdout.join("")).toContain("Usage: vitehub connections <command> [name] [--url <url>]")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("sets an API key from stdin without printing it", async () => {
    const fetch = stubFetch(() => Response.json({ connection: { ...summary, account: undefined, expiresAt: undefined, kind: "api-key", name: "executor", provider: "api-key" } }))
    const io = context()

    expect(await feature("set-key", async () => "sk_cli_marker").run(["executor"], io.context)).toBe(0)
    expect(request(fetch).body).toEqual({ action: "set-key", key: "sk_cli_marker", name: "executor" })
    // A redirect would resend the key to another URL.
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error")
    // Other commands have no key in the body and follow redirects.
    await feature("list").run([], context().context)
    expect(fetch.mock.calls[1]?.[1]?.redirect).toBe("follow")
    expect(io.stdout.join("")).toMatch(/^executor\s+api-key\s+active/)
    expect(io.stdout.join("") + io.stderr.join("")).not.toContain("sk_cli_marker")
  })

  it("sends a key only over HTTPS or to a loopback server", async () => {
    for (const url of ["https://app.example", "http://localhost:5173", "http://app.localhost:3000", "http://127.0.0.1:4000", "http://[::1]:5173"]) {
      expect(() => assertKeyTarget(url)).not.toThrow()
    }
    for (const url of ["http://remote-host:5173", "http://10.0.0.2:5173", "http://localhost.example.com"]) {
      expect(() => assertKeyTarget(url)).toThrow("only over HTTPS or to a loopback server")
    }
    const fetch = stubFetch(() => Response.json({}))
    const readKey = vi.fn(async () => "sk_never_sent")
    const io = context()
    expect(await feature("set-key", readKey).run(["executor", "--url", "http://remote-host:5173"], io.context)).toBe(1)
    expect(readKey).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("reads a piped key and rejects a terminal or an empty pipe", async () => {
    // SAFETY: A Readable stream matches the parts of NodeJS.ReadStream that readPipedKey uses.
    const pipe = (text: string, isTTY = false) => Object.assign(Readable.from([text]), { isTTY }) as unknown as NodeJS.ReadStream
    await expect(readPipedKey(pipe("  sk_piped\n"))).resolves.toBe("sk_piped")
    await expect(readPipedKey(pipe("\n"))).rejects.toThrow("empty")
    await expect(readPipedKey(pipe("sk", true))).rejects.toThrow("Pipe the key on stdin")
  })
})
