import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"

import { describe, expect, it, vi } from "vitest"

import { createKVCliContributor, runKVCli } from "../src/cli.ts"
import { kvDevHeader, kvDevHeaderValue, kvDevRoute, kvDevRuntimeRoute } from "../src/dev.ts"
import { kvDevRuntimeUnavailableMessage, registerKVDevEndpoint } from "../src/vite-dev.ts"
import { hubKv } from "../src/vite.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { KVDevServer } from "../src/vite-dev.ts"

const rootDir = "/app"

function stream() {
  let value = ""
  const bytes: Uint8Array[] = []
  return {
    bytes: () => bytes,
    output: () => value,
    write(chunk: string | Uint8Array) {
      if (typeof chunk !== "string") bytes.push(chunk)
      value += String(chunk)
      return true
    },
  }
}

function context(cwd = rootDir) {
  const stdout = stream()
  const stderr = stream()
  return { context: { cwd, env: {}, rootDir, stderr, stdout }, stderr, stdout }
}

/** Fake dev server: `GET` discovery, then one `POST` operation. */
function devServer(result: unknown, init: { discovery?: Record<string, unknown>, status?: number } = {}) {
  return vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST"
    ? Response.json(result, { status: init.status ?? 200 })
    : Response.json(init.discovery ?? { root: rootDir, runtime: "nitro" }))
}

function sentBody(fetch: ReturnType<typeof devServer>): unknown {
  return JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))
}

describe("vitehub kv", () => {
  it("lists keys as lines and as JSON", async () => {
    const result = { cursor: "next", keys: ["users:1", "users:2"], limit: 2, prefix: "users:", store: "default", stores: ["default", "cache"] }
    const human = context()
    const fetch = devServer(result)

    await expect(runKVCli(["list", "--prefix", "users:", "--limit=2", "--url", "http://127.0.0.1:4321"], human.context, { fetch })).resolves.toBe(0)

    expect(human.stdout.output()).toBe("users:1\nusers:2\n")
    expect(human.stderr.output()).toBe("More keys exist. Next page: --cursor next\n")
    const [discovery, operation] = fetch.mock.calls
    expect(String(discovery?.[0])).toBe(`http://127.0.0.1:4321${kvDevRoute}`)
    expect(operation?.[1]).toMatchObject({
      body: JSON.stringify({ limit: 2, operation: "list", prefix: "users:" }),
      headers: { "content-type": "application/json", [kvDevHeader]: kvDevHeaderValue },
      method: "POST",
    })

    const json = context()
    const jsonFetch = devServer(result)
    await expect(runKVCli(["list", "--cursor", "next", "--store", "cache", "--json"], json.context, { fetch: jsonFetch })).resolves.toBe(0)
    expect(sentBody(jsonFetch)).toEqual({ cursor: "next", operation: "list", store: "cache" })
    expect(JSON.parse(json.stdout.output())).toEqual(result)

    const empty = context()
    await expect(runKVCli(["list"], empty.context, { fetch: devServer({ keys: [], limit: 100, prefix: "", store: "default", stores: ["default"] }) })).resolves.toBe(0)
    expect(empty.stdout.output()).toBe("No keys in store default.\n")
  })

  it("prints values and reports missing keys with exit code 1", async () => {
    const text = context()
    await expect(runKVCli(["get", "greeting"], text.context, { fetch: devServer({ found: true, key: "greeting", store: "default", type: "string", value: "hello" }) })).resolves.toBe(0)
    expect(text.stdout.output()).toBe("hello\n")

    const object = context()
    await expect(runKVCli(["get", "settings"], object.context, { fetch: devServer({ found: true, key: "settings", store: "default", type: "object", value: { theme: "dark" } }) })).resolves.toBe(0)
    expect(object.stdout.output()).toBe("{\n  \"theme\": \"dark\"\n}\n")

    const bytes = context()
    await expect(runKVCli(["get", "raw"], bytes.context, { fetch: devServer({ encoding: "base64", found: true, key: "raw", store: "default", type: "bytes", value: "AP8B" }) })).resolves.toBe(0)
    expect(bytes.stdout.bytes()).toEqual([Uint8Array.from([0, 255, 1])])

    const missing = context()
    await expect(runKVCli(["get", "missing"], missing.context, { fetch: devServer({ found: false, key: "missing", store: "default" }) })).resolves.toBe(1)
    expect(missing.stdout.output()).toBe("")
    expect(missing.stderr.output()).toBe("Key missing was not found in store default.\n")

    const missingJson = context()
    await expect(runKVCli(["get", "missing", "--json"], missingJson.context, { fetch: devServer({ found: false, key: "missing", store: "default" }) })).resolves.toBe(1)
    expect(JSON.parse(missingJson.stdout.output())).toEqual({ found: false, key: "missing", store: "default" })
  })

  it("uses the exit code of has", async () => {
    const exists = context()
    await expect(runKVCli(["has", "a"], exists.context, { fetch: devServer({ exists: true, key: "a", store: "default" }) })).resolves.toBe(0)
    expect(exists.stdout.output()).toBe("Key a exists in store default.\n")

    const absent = context()
    await expect(runKVCli(["has", "a", "--json"], absent.context, { fetch: devServer({ exists: false, key: "a", store: "default" }) })).resolves.toBe(1)
    expect(JSON.parse(absent.stdout.output())).toEqual({ exists: false, key: "a", store: "default" })
  })

  it("prints what set and del changed", async () => {
    const created = context()
    const fetch = devServer({ created: true, key: "greeting", notice: "The fs-lite driver ignores TTL. The value does not expire.", store: "default", ttl: 60, type: "string" })
    await expect(runKVCli(["set", "greeting", "hello", "--ttl", "60"], created.context, { fetch })).resolves.toBe(0)
    expect(sentBody(fetch)).toEqual({ key: "greeting", operation: "set", ttl: 60, value: "hello" })
    expect(created.stdout.output()).toBe("Created key greeting in store default (string, TTL 60 s).\nThe fs-lite driver ignores TTL. The value does not expire.\n")

    const updated = context()
    const jsonValue = devServer({ created: false, key: "settings", store: "cache", type: "object" })
    await expect(runKVCli(["set", "settings", "{\"theme\":\"dark\"}", "--json-value", "--store", "cache"], updated.context, { fetch: jsonValue })).resolves.toBe(0)
    expect(sentBody(jsonValue)).toEqual({ key: "settings", operation: "set", store: "cache", value: { theme: "dark" } })
    expect(updated.stdout.output()).toBe("Updated key settings in store cache (object).\n")

    const deleted = context()
    await expect(runKVCli(["del", "greeting"], deleted.context, { fetch: devServer({ deleted: true, key: "greeting", store: "default" }) })).resolves.toBe(0)
    expect(deleted.stdout.output()).toBe("Deleted key greeting from store default.\n")

    const unchanged = context()
    await expect(runKVCli(["del", "greeting"], unchanged.context, { fetch: devServer({ deleted: false, key: "greeting", store: "default" }) })).resolves.toBe(0)
    expect(unchanged.stdout.output()).toBe("Key greeting did not exist in store default. Nothing changed.\n")

    const json = context()
    await expect(runKVCli(["del", "greeting", "--json"], json.context, { fetch: devServer({ deleted: false, key: "greeting", store: "default" }) })).resolves.toBe(0)
    expect(JSON.parse(json.stdout.output())).toEqual({ deleted: false, key: "greeting", store: "default" })
  })

  it("reads a value from a file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-kv-cli-"))
    try {
      await writeFile(join(directory, "value.json"), "{\"items\":[1,2]}\n")
      const file = context(directory)
      const fetch = devServer({ created: true, key: "list", store: "default", type: "object" })
      await expect(runKVCli(["set", "list", "@value.json", "--json-value"], file.context, { fetch })).resolves.toBe(0)
      expect(sentBody(fetch)).toEqual({ key: "list", operation: "set", value: { items: [1, 2] } })

      const text = context(directory)
      const textFetch = devServer({ created: true, key: "raw", store: "default", type: "string" })
      await expect(runKVCli(["set", "raw", "@value.json"], text.context, { fetch: textFetch })).resolves.toBe(0)
      expect(sentBody(textFetch)).toMatchObject({ value: await readFile(join(directory, "value.json"), "utf8") })
    }
    finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("reports runtime errors on stderr, or as JSON with --json", async () => {
    const failure = { error: { code: "KV_STORE_NOT_FOUND", message: "KV store \"missing\" was not found. Stores: default." } }
    const human = context()
    await expect(runKVCli(["get", "a", "--store", "missing"], human.context, { fetch: devServer(failure, { status: 404 }) })).resolves.toBe(1)
    expect(human.stdout.output()).toBe("")
    expect(human.stderr.output()).toBe("KV store \"missing\" was not found. Stores: default.\n")

    const json = context()
    await expect(runKVCli(["get", "a", "--store=missing", "--json"], json.context, { fetch: devServer(failure, { status: 404 }) })).resolves.toBe(1)
    expect(JSON.parse(json.stdout.output())).toEqual(failure)

    const guard = context()
    await expect(runKVCli(["list"], guard.context, {
      fetch: vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST"
        ? new Response("Forbidden KV Dev request.", { status: 403 })
        : Response.json({ root: rootDir, runtime: "nitro" })),
    })).resolves.toBe(1)
    expect(guard.stderr.output()).toBe("Forbidden KV Dev request.\n")
  })

  it("explains hosts that cannot reach the KV runtime", async () => {
    const unavailable = context()
    const fetch = devServer({}, { discovery: { message: kvDevRuntimeUnavailableMessage, root: rootDir, runtime: "unavailable" } })
    await expect(runKVCli(["list", "--json"], unavailable.context, { fetch })).resolves.toBe(1)
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(unavailable.stdout.output())).toEqual({
      error: { code: "KV_DEV_RUNTIME_UNAVAILABLE", message: kvDevRuntimeUnavailableMessage },
    })

    const missing = context()
    await expect(runKVCli(["list"], missing.context, { fetch: vi.fn(async () => new Response("Not found", { status: 404 })) })).resolves.toBe(1)
    expect(missing.stderr.output()).toBe([
      "No Compatible Vite Development Server found at http://localhost:5173.",
      "`vitehub kv` needs a running Vite + Nitro Development Server with `kv` enabled. Nuxt and plain Vite are not supported.",
      "",
    ].join("\n"))
  })

  it("validates arguments before it calls the server", async () => {
    const fetch = vi.fn()
    const cases: Array<[string[], string]> = [
      [["get"], "Missing key."],
      [["set", "a"], "Missing value."],
      [["set", "a", "b", "c"], "Unexpected argument: c."],
      [["set", "a", "{", "--json-value"], "The value is not valid JSON"],
      [["set", "a", "b", "--ttl", "0"], "--ttl must be a positive integer."],
      [["list", "--limit", "5000"], "--limit must be at most 1000."],
      [["list", "--ttl", "5"], "Unknown option: --ttl."],
      [["get", "a", "--prefix", "x"], "Unknown option: --prefix."],
      [["list", "--store"], "--store needs a value."],
    ]
    for (const [args, message] of cases) {
      const invalid = context()
      await expect(runKVCli(args, invalid.context, { fetch })).resolves.toBe(1)
      expect(invalid.stderr.output(), args.join(" ")).toContain(message)
      expect(invalid.stderr.output()).toContain("Usage: vitehub kv")
    }
    const unknown = context()
    await expect(runKVCli(["clear"], unknown.context, { fetch })).resolves.toBe(1)
    expect(unknown.stderr.output()).toBe("Unknown kv command: clear\nCommands: list, get, has, set, del\n")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("contributes one feature per command and no clear command", () => {
    const [namespace] = createKVCliContributor().namespaces
    expect(namespace?.name).toBe("kv")
    expect(namespace?.features.map(feature => feature.name)).toEqual(["list", "get", "has", "set", "del"])
    expect(namespace?.features.find(feature => feature.name === "set")?.usage).toBe(
      "vitehub kv set <key> <value|@file> [--ttl <seconds>] [--json-value] [--store <name>] [--json] [--url <url>]",
    )
  })
})

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

function fakeServer(environments?: Record<string, unknown>) {
  const middlewares: Middleware[] = []
  const server: KVDevServer = {
    config: { root: rootDir, server: { port: 5173 } },
    environments,
    middlewares: { use: handler => middlewares.push(handler) },
  }
  return { middlewares, server }
}

async function call(middleware: Middleware, init: { body?: string, headers?: Record<string, string>, method: string }) {
  const req = Object.assign(Readable.from(init.body ? [Buffer.from(init.body)] : []), {
    headers: { host: "localhost:5173", ...init.headers },
    method: init.method,
    url: kvDevRoute,
  }) as unknown as IncomingMessage
  const done = new EventEmitter()
  const chunks: Buffer[] = []
  const headers: Record<string, string> = {}
  const res = {
    end() {
      done.emit("end")
    },
    setHeader(name: string, value: string) {
      headers[name] = value
    },
    statusCode: 200,
    write(chunk: Buffer) {
      chunks.push(chunk)
    },
  }
  const ended = new Promise(resolve => done.once("end", resolve))
  middleware(req, res as unknown as ServerResponse, () => done.emit("end"))
  await ended
  return { body: Buffer.concat(chunks).toString("utf8"), headers, status: res.statusCode }
}

const guard = { [kvDevHeader]: kvDevHeaderValue }

describe("KV dev endpoint", () => {
  it("rejects requests without the guard header or from another origin", async () => {
    const { middlewares, server } = fakeServer()
    registerKVDevEndpoint(server)

    expect(await call(middlewares[0]!, { method: "GET" })).toMatchObject({ body: "Forbidden KV Dev request.", status: 403 })
    expect(await call(middlewares[0]!, { headers: { ...guard, origin: "https://attacker.test" }, method: "GET" })).toMatchObject({ status: 403 })
    expect(await call(middlewares[0]!, { body: "{}", headers: { ...guard, "content-type": "text/plain" }, method: "POST" })).toMatchObject({ status: 415 })
    expect(await call(middlewares[0]!, { headers: guard, method: "DELETE" })).toMatchObject({ status: 405 })
  })

  it("returns 501 on hosts without an in-process Nitro environment", async () => {
    const { middlewares, server } = fakeServer()
    registerKVDevEndpoint(server)

    const discovery = await call(middlewares[0]!, { headers: guard, method: "GET" })
    expect(JSON.parse(discovery.body)).toEqual({ message: kvDevRuntimeUnavailableMessage, root: rootDir, runtime: "unavailable" })
    const operation = await call(middlewares[0]!, { body: "{\"operation\":\"list\"}", headers: { ...guard, "content-type": "application/json" }, method: "POST" })
    expect(operation.status).toBe(501)
    expect(JSON.parse(operation.body)).toMatchObject({ error: { code: "KV_DEV_RUNTIME_UNAVAILABLE" } })
  })

  it("forwards operations into the Nitro environment under the Nitro base URL", async () => {
    const dispatchFetch = vi.fn(async (request: Request) => Response.json({ body: await request.text(), url: request.url }))
    const { middlewares, server } = fakeServer({ nitro: { dispatchFetch } })
    registerKVDevEndpoint(server, { nitroBaseURL: () => "/app/" })

    expect(JSON.parse((await call(middlewares[0]!, { headers: guard, method: "GET" })).body)).toEqual({ root: rootDir, runtime: "nitro" })
    const operation = await call(middlewares[0]!, { body: "{\"operation\":\"list\"}", headers: { ...guard, "content-type": "application/json" }, method: "POST" })

    expect(operation.status).toBe(200)
    expect(operation.headers["cache-control"]).toBe("no-store")
    expect(JSON.parse(operation.body)).toEqual({ body: "{\"operation\":\"list\"}", url: `http://localhost/app${kvDevRuntimeRoute}` })
    expect(dispatchFetch.mock.calls[0]?.[0].headers.get(kvDevHeader)).toBe(kvDevHeaderValue)
  })
})

describe("hubKv dev handler", () => {
  type ConfigHook = (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<void>

  function configHook(importBase?: string): ConfigHook {
    const plugin = hubKv({ base: ".data/kv", driver: "fs-lite" }, importBase ? { importBase } : {})
    const hook = plugin.config
    const handler = hook && "handler" in hook ? hook.handler : hook
    // SAFETY: The test calls the concrete hook with the Vite config fields that it reads.
    return handler as unknown as ConfigHook
  }

  it("adds the Nitro route only in serve mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-kv-vite-"))
    try {
      const build: Record<string, unknown> = { nitro: { handlers: [] }, root }
      await configHook()(build, { command: "build", mode: "production" })
      expect(build.nitro).toEqual({ handlers: [] })

      const serve: Record<string, unknown> = { nitro: { baseURL: "/app/", handlers: [] }, root }
      await configHook("vite-hub/_internal/kv")(serve, { command: "serve", mode: "development" })
      const handler = join(root, ".vitehub/nitro/kv/dev-handler.ts")
      expect(serve.nitro).toEqual({ baseURL: "/app/", handlers: [{ handler, route: kvDevRuntimeRoute }], plugins: [] })
      expect(await readFile(handler, "utf8")).toContain("import { handleKVDevRequest as handleViteHubDevRequest } from \"vite-hub/_internal/kv/runtime/dev\"")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("contributes the kv CLI namespace", () => {
    expect(hubKv().vitehub.cli).toEqual(expect.any(Function))
  })
})
