import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { EventEmitter } from "node:events"
import { Readable } from "node:stream"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createViteHubDevToken, readViteHubDevToken, removeViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"

import { createScheduleCliContributor, runScheduleCli } from "../src/cli.ts"
import { summarizeScheduleRun } from "../src/runtime/console.ts"
import { scheduleDevHeader, scheduleDevHeaderValue, scheduleDevRoute, scheduleDevRuntimeRoute, scheduleDevTokenNamespace, scheduleDevTokenServerHeader } from "../src/dev.ts"
import { registerScheduleDevEndpoint, scheduleDevRuntimeUnavailableMessage } from "../src/vite-dev.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { ScheduleDevServer } from "../src/vite-dev.ts"

const rootDir = "/app"
let credential: { serverId: string, token: string }
const closeServers: EventEmitter[] = []
beforeEach(async () => { credential = await createViteHubDevToken(rootDir, scheduleDevTokenNamespace) })
afterEach(async () => {
  for (const server of closeServers.splice(0)) server.emit("close")
  await removeViteHubDevToken(rootDir, { namespace: scheduleDevTokenNamespace, serverId: credential.serverId })
})

function stream() {
  let value = ""
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += String(chunk)
      return true
    },
  }
}

function context() {
  const stdout = stream()
  const stderr = stream()
  return { context: { cwd: rootDir, env: {}, rootDir, stderr, stdout }, stderr, stdout }
}

const digest = {
  console: { dispatch: false, visible: true },
  createdAt: "2026-05-01T00:00:00.000Z",
  cron: "0 9 * * *",
  enabled: true,
  id: "digest",
  input: { token: "[redacted]" },
  lastRun: { attemptCount: 1, id: "srun_runtime_digest_2026-05-22T07:00:00.000Z", scheduleId: "digest", scheduledAt: "2026-05-22T07:00:00.000Z", status: "succeeded", target: "report" },
  nextRunAt: "2026-05-23T07:00:00.000Z",
  target: "report",
  timeZone: "Europe/Copenhagen",
  updatedAt: "2026-05-01T00:00:00.000Z",
}

/** Fake dev server: `GET` discovery, then one `POST` operation. */
function devServer(result: unknown, init: { discovery?: Record<string, unknown>, status?: number } = {}) {
  return vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST"
    ? Response.json(result, { status: init.status ?? 200 })
    : Response.json(init.discovery ?? { root: rootDir, runtime: "nitro", scheduleDevTokenServerId: credential.serverId }))
}

describe("vitehub schedule", () => {
  it.each([false, true])("rejects malformed operation results with json %s", async (json) => {
    const output = context()
    expect(await runScheduleCli(["list", ...(json ? ["--json"] : [])], output.context, { fetch: devServer({ automaticRuns: false, schedules: "invalid" }) })).toBe(1)
    if (json) expect(JSON.parse(output.stdout.output())).toEqual({ error: { message: "The Schedule Dev response has an invalid result shape." } })
    else expect(output.stderr.output()).toContain("invalid result shape")
  })

  it("returns parseable JSON errors through the executable entrypoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-schedule-cli-proof-"))
    const cli = resolve(import.meta.dirname, "../../cli/src/index.ts")
    try {
      await mkdir(join(directory, "node_modules/@vite-hub"), { recursive: true })
      await symlink(resolve(import.meta.dirname, ".."), join(directory, "node_modules/@vite-hub/schedule"), "dir")
      await writeFile(join(directory, "vite.config.mjs"), 'import { hubSchedule } from "@vite-hub/schedule/vite"; export default { plugins: [hubSchedule()] };')
      const help = spawnSync(process.execPath, [cli, "schedule", "get", "--help"], { cwd: directory, encoding: "utf8", timeout: 30_000 })
      expect(help.status, help.stderr).toBe(0)
      expect(help.stdout).toContain("vitehub schedule get")
      const failure = spawnSync(process.execPath, [cli, "schedule", "get", "--json"], { cwd: directory, encoding: "utf8", timeout: 30_000 })
      expect(failure.status).toBe(1)
      expect(JSON.parse(failure.stdout)).toMatchObject({ error: { message: expect.any(String) } })
      expect(failure.stderr).toBe("")
      const literal = spawnSync(process.execPath, [cli, "schedule", "get", "--json", "--", "-daily"], { cwd: directory, env: { ...process.env, VITEHUB_DEV_SERVER_URL: "http://127.0.0.1:1" }, encoding: "utf8", timeout: 30_000 })
      expect(literal.status).toBe(1)
      expect(JSON.parse(literal.stdout).error.message).toContain("No Compatible Vite Development Server")
      expect(literal.stderr).toBe("")
      expect(help.stdout).toContain("End options")
      for (const timeoutArgs of [["--timeout", "4294967296"], ["--timeout=2147483648"]]) {
        const overflow = spawnSync(process.execPath, [cli, "schedule", "list", "--json", ...timeoutArgs], { cwd: directory, encoding: "utf8", timeout: 30_000 })
        expect(overflow.status).toBe(1)
        expect(JSON.parse(overflow.stdout).error.message).toContain("2147483647")
        expect(overflow.stderr).toBe("")
      }
    }
    finally {
      await rm(directory, { force: true, recursive: true })
    }
  }, 60_000)

  it.each([["get", "--json"], ["runs", "digest", "--json", "--limit", "0"]])("returns argument failures as JSON for %j", async (...args) => {
    const result = context()
    expect(await runScheduleCli(args, result.context)).toBe(1)
    expect(JSON.parse(result.stdout.output())).toMatchObject({ error: { message: expect.any(String) } })
    expect(result.stderr.output()).toBe("")
  })

  it("returns discovery failures as JSON without human diagnostics", async () => {
    const result = context()
    expect(await runScheduleCli(["list", "--json"], result.context, {
      fetch: async () => { throw new Error("unreachable") },
    })).toBe(1)
    expect(JSON.parse(result.stdout.output())).toMatchObject({ error: { message: expect.stringContaining("No Compatible") } })
    expect(result.stderr.output()).toBe("")
  })

  it("times out during discovery using the command signal", async () => {
    const result = context()
    let signal: AbortSignal | null | undefined
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      signal = init?.signal
      await new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal?.reason), { once: true }))
      return Response.json({})
    }
    expect(await runScheduleCli(["list", "--json", "--timeout", "10"], result.context, { fetch })).toBe(1)
    expect(signal?.aborted).toBe(true)
    expect(JSON.parse(result.stdout.output())).toHaveProperty("error")
  })

  it("lists Runtime Schedules as a table and as JSON", async () => {
    const result = { automaticRuns: false, schedules: [digest] }
    const human = context()
    const fetch = devServer(result)

    await expect(runScheduleCli(["list", "--url", "http://127.0.0.1:4321"], human.context, { fetch })).resolves.toBe(0)

    expect(human.stdout.output()).toBe([
      "ID      TARGET  CRON                           ENABLED  NEXT RUN                  LAST RUN",
      "digest  report  0 9 * * * (Europe/Copenhagen)  yes      2026-05-23T07:00:00.000Z  succeeded 2026-05-22T07:00:00.000Z",
      "Automatic runs: off. No wake driver is installed, so due times do not start runs in this runtime.",
      "",
    ].join("\n"))
    const [discovery, operation] = fetch.mock.calls
    expect(String(discovery?.[0])).toBe(`http://127.0.0.1:4321${scheduleDevRoute}`)
    expect(operation?.[1]).toMatchObject({
      body: JSON.stringify({ operation: "list" }),
      headers: { "content-type": "application/json", [scheduleDevHeader]: scheduleDevHeaderValue, [viteHubDevTokenHeader]: credential.token, [scheduleDevTokenServerHeader]: credential.serverId },
      method: "POST",
    })

    const json = context()
    await expect(runScheduleCli(["list", "--json"], json.context, { fetch: devServer(result) })).resolves.toBe(0)
    expect(JSON.parse(json.stdout.output())).toEqual(result)
  })

  it("prints one Schedule, its runs, and attempts", async () => {
    const get = context()
    await expect(runScheduleCli(["get", "digest"], get.context, { fetch: devServer({ automaticRuns: true, schedule: digest }) })).resolves.toBe(0)
    expect(get.stdout.output()).toContain("Schedule: digest\nTarget: report\n")
    expect(get.stdout.output()).toContain("Input: {\"token\":\"[redacted]\"}\n")
    expect(get.stdout.output()).toContain("Automatic runs: on.")

    const runs = context()
    const fetch = devServer({ runs: [{ ...digest.lastRun, error: { message: "Timed out" }, status: "failed" }] })
    await expect(runScheduleCli(["runs", "digest", "--limit=5"], runs.context, { fetch })).resolves.toBe(0)
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ id: "digest", limit: 5, operation: "runs" }))
    expect(runs.stdout.output()).toContain("srun_runtime_digest_2026-05-22T07:00:00.000Z  failed  2026-05-22T07:00:00.000Z  1         Timed out")

    const attempts = context()
    await expect(runScheduleCli(["attempts", digest.lastRun.id], attempts.context, {
      fetch: devServer({ attempts: [], run: digest.lastRun }),
    })).resolves.toBe(0)
    expect(attempts.stdout.output()).toBe(`Run: ${digest.lastRun.id} (succeeded)\nNo attempts.\n`)
  })

  it("runs, enables, and disables a Schedule", async () => {
    const run = context()
    await expect(runScheduleCli(["run-runtime", "digest"], run.context, {
      fetch: devServer({ run: { ...digest.lastRun, response: { status: 204, statusText: "No Content" } } }),
    })).resolves.toBe(0)
    expect(run.stdout.output()).toBe(`Run ${digest.lastRun.id}: succeeded (HTTP 204 No Content)\n`)

    const enable = context()
    await expect(runScheduleCli(["enable", "digest"], enable.context, { fetch: devServer({ schedule: digest }) })).resolves.toBe(0)
    expect(enable.stdout.output()).toBe("Enabled Schedule digest. Next run: 2026-05-23T07:00:00.000Z.\n")

    const disable = context()
    await expect(runScheduleCli(["disable", "digest"], disable.context, {
      fetch: devServer({ schedule: { ...digest, enabled: false, nextRunAt: undefined } }),
    })).resolves.toBe(0)
    expect(disable.stdout.output()).toBe("Disabled Schedule digest.\n")
  })

  it("exits with 1 when a manual run fails", async () => {
    const failed = { ...digest.lastRun, error: { message: "Target failed", name: "Error" }, status: "failed" }
    const human = context()
    await expect(runScheduleCli(["run-runtime", "digest"], human.context, { fetch: devServer({ run: failed }) })).resolves.toBe(1)
    expect(human.stdout.output()).toContain("Error: Error: Target failed\n")

    const json = context()
    await expect(runScheduleCli(["run-runtime", "digest", "--json"], json.context, { fetch: devServer({ run: failed }) })).resolves.toBe(1)
    expect(JSON.parse(json.stdout.output())).toEqual({ run: failed })
  })

  it.each([false, true])("keeps redacted error names in CLI output with json %s", async (json) => {
    const scheduledAt = new Date(digest.lastRun.scheduledAt)
    const run = summarizeScheduleRun({ ...digest.lastRun, scheduledAt, createdAt: scheduledAt, updatedAt: scheduledAt,
      error: { message: "Target failed", name: "Authorization: Bearer error-name-secret" }, status: "failed" })
    const output = context()
    expect(await runScheduleCli(["run-runtime", "digest", ...(json ? ["--json"] : [])], output.context, { fetch: devServer({ run }) })).toBe(1)
    expect(output.stdout.output()).not.toContain("error-name-secret")
    if (json) expect(JSON.parse(output.stdout.output()).run.error.name).toBe("Authorization: [redacted]")
    else expect(output.stdout.output()).toContain("Error: Authorization: [redacted]: Target failed")
  })

  it.each([false, true])("redacts response status text in CLI output with json %s", async (json) => {
    const scheduledAt = new Date(digest.lastRun.scheduledAt)
    const run = summarizeScheduleRun({ ...digest.lastRun, scheduledAt, createdAt: scheduledAt, updatedAt: scheduledAt,
      response: { body: { data: "", encoding: "base64", mediaType: "text/plain" }, headers: [], status: 200, statusText: "Authorization: Bearer status-secret" }, status: "succeeded" })
    const output = context()
    expect(await runScheduleCli(["run-runtime", "digest", ...(json ? ["--json"] : [])], output.context, { fetch: devServer({ run }) })).toBe(0)
    expect(output.stdout.output()).not.toContain("status-secret")
    if (json) expect(JSON.parse(output.stdout.output()).run.response.statusText).toBe("Authorization: [redacted]")
    else expect(output.stdout.output()).toContain("HTTP 200 Authorization: [redacted]")
  })

  it.each(["-daily", "--json", "--help"])("accepts literal Schedule ID %s after the option terminator", async (id) => {
    const output = context()
    const fetch = devServer({ automaticRuns: true, schedule: { ...digest, id } })
    expect(await runScheduleCli(["get", "--json", "--", id], output.context, { fetch }), output.stdout.output() + output.stderr.output()).toBe(0)
    expect(JSON.parse(output.stdout.output()).schedule.id).toBe(id)
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({ id, operation: "get" })
  })

  it.each([false, true])("reports non-success response body failures with json %s", async (json) => {
    const output = context()
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      if (init?.method !== "POST") return Response.json({ root: rootDir, runtime: "nitro", scheduleDevTokenServerId: credential.serverId })
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error("response body interrupted")) } }), { status: 503 })
    }
    expect(await runScheduleCli(["get", "digest", ...(json ? ["--json"] : [])], output.context, { fetch })).toBe(1)
    if (json) {
      expect(JSON.parse(output.stdout.output()).error.message).toContain("response body interrupted")
      expect(output.stderr.output()).toBe("")
    }
    else {
      expect(output.stdout.output()).toBe("")
      expect(output.stderr.output()).toContain("response body interrupted")
    }
  })

  it("returns JSON when the timeout interrupts a non-success response body", async () => {
    const output = context()
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      if (init?.method !== "POST") return Response.json({ root: rootDir, runtime: "nitro", scheduleDevTokenServerId: credential.serverId })
      return new Response(new ReadableStream({ start(controller) {
        init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true })
      } }), { status: 503 })
    }
    expect(await runScheduleCli(["get", "digest", "--json", "--timeout", "10"], output.context, { fetch })).toBe(1)
    expect(JSON.parse(output.stdout.output()).error.message).toContain("timeout")
    expect(output.stderr.output()).toBe("")
  })

  it.each([
    ["text", false], ["text", true], ["json", false], ["json", true], ["stream", false], ["stream", true],
  ])("redacts %s response failure messages with json %s", async (kind, json) => {
    const output = context()
    const message = "Authorization: Bearer failure-secret"
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      if (init?.method !== "POST") return Response.json({ root: rootDir, runtime: "nitro", scheduleDevTokenServerId: credential.serverId })
      if (kind === "text") return new Response(message, { status: 503 })
      if (kind === "json") return Response.json({ error: { code: "SCHEDULE_NOT_FOUND", message } }, { status: 404 })
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error(message)) } }), { status: 503 })
    }
    expect(await runScheduleCli(["get", "digest", ...(json ? ["--json"] : [])], output.context, { fetch })).toBe(1)
    expect(output.stdout.output() + output.stderr.output()).not.toContain("failure-secret")
    const expected = `${kind === "stream" ? "Schedule Dev request failed: " : ""}Authorization: [redacted]`
    if (json) {
      const error = JSON.parse(output.stdout.output()).error
      expect(error.message).toBe(expected)
      if (kind === "json") expect(error.code).toBe("SCHEDULE_NOT_FOUND")
      expect(output.stderr.output()).toBe("")
    }
    else {
      expect(output.stderr.output()).toBe(`${expected}\n`)
      expect(output.stdout.output()).toBe("")
    }
  })

  it.each(["2147483648", "4294967296"])("rejects timeout %s as JSON before discovery", async timeout => {
    const output = context()
    const fetch = vi.fn()
    expect(await runScheduleCli(["list", "--json", "--timeout", timeout], output.context, { fetch })).toBe(1)
    expect(JSON.parse(output.stdout.output()).error.message).toContain("2147483647")
    expect(output.stderr.output()).toBe("")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("accepts the maximum timer duration without altering it", async () => {
    const output = context()
    const fetch = devServer({ automaticRuns: false, schedules: [] })
    expect(await runScheduleCli(["list", "--timeout=2147483647"], output.context, { fetch })).toBe(0)
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it.each([false, true])("rejects a missing local private token with json %s before POST", async json => {
    await removeViteHubDevToken(rootDir, { namespace: scheduleDevTokenNamespace, serverId: credential.serverId })
    const output = context()
    const fetch = devServer({})
    expect(await runScheduleCli(["list", ...(json ? ["--json"] : [])], output.context, { fetch })).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    if (json) {
      expect(JSON.parse(output.stdout.output()).error.message).toContain("No private Schedule Dev token")
      expect(output.stderr.output()).toBe("")
    }
    else expect(output.stderr.output()).toContain("No private Schedule Dev token")
  })

  it("reports runtime errors on stderr, or as JSON with --json", async () => {
    const failure = { error: { code: "SCHEDULE_NOT_FOUND", message: "Runtime Schedule was not found." } }
    const human = context()
    await expect(runScheduleCli(["get", "missing"], human.context, { fetch: devServer(failure, { status: 404 }) })).resolves.toBe(1)
    expect(human.stdout.output()).toBe("")
    expect(human.stderr.output()).toBe("Runtime Schedule was not found.\n")

    const json = context()
    await expect(runScheduleCli(["get", "missing", "--json"], json.context, { fetch: devServer(failure, { status: 404 }) })).resolves.toBe(1)
    expect(JSON.parse(json.stdout.output())).toEqual(failure)
  })

  it("explains hosts that cannot reach the Schedule runtime", async () => {
    const unavailable = context()
    const fetch = devServer({}, { discovery: { message: scheduleDevRuntimeUnavailableMessage, root: rootDir, runtime: "unavailable" } })
    await expect(runScheduleCli(["list", "--json"], unavailable.context, { fetch })).resolves.toBe(1)
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(unavailable.stdout.output())).toEqual({
      error: { code: "SCHEDULE_DEV_RUNTIME_UNAVAILABLE", message: scheduleDevRuntimeUnavailableMessage },
    })

    const missing = context()
    await expect(runScheduleCli(["list"], missing.context, { fetch: vi.fn(async () => new Response("Not found", { status: 404 })) })).resolves.toBe(1)
    expect(missing.stderr.output()).toBe([
      "No Compatible Vite Development Server found at http://localhost:5173.",
      "`vitehub schedule` needs a running Vite + Nitro Development Server with `schedule` enabled. Nuxt and plain Vite are not supported.",
      "",
    ].join("\n"))
  })

  it("validates arguments before it calls the server", async () => {
    const fetch = vi.fn()
    const missingId = context()
    await expect(runScheduleCli(["get"], missingId.context, { fetch })).resolves.toBe(1)
    expect(missingId.stderr.output()).toContain("Missing Schedule id.")
    const limit = context()
    await expect(runScheduleCli(["runs", "digest", "--limit", "0"], limit.context, { fetch })).resolves.toBe(1)
    expect(limit.stderr.output()).toContain("--limit must be a positive integer.")
    const unknown = context()
    await expect(runScheduleCli(["list", "--limit", "2"], unknown.context, { fetch })).resolves.toBe(1)
    expect(unknown.stderr.output()).toContain("Unknown option: --limit.")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("contributes one feature per command", () => {
    const [namespace] = createScheduleCliContributor().namespaces
    expect(namespace?.name).toBe("schedule")
    expect(namespace?.features.map(feature => feature.name)).toEqual(["run", "list", "get", "runs", "attempts", "run-runtime", "enable", "disable"])
  })
})

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

function fakeServer(environments?: Record<string, unknown>) {
  const middlewares: Middleware[] = []
  const httpServer = new EventEmitter()
  closeServers.push(httpServer)
  const server: ScheduleDevServer = {
    httpServer,
    config: { root: rootDir, server: { port: 5173 } },
    environments,
    middlewares: { use: handler => middlewares.push(handler) },
  }
  return { middlewares, server, httpServer }
}

async function call(middleware: Middleware, init: { body?: string, headers?: Record<string, string>, method: string }) {
  const req = Object.assign(Readable.from(init.body ? [Buffer.from(init.body)] : []), {
    headers: { host: "localhost:5173", ...init.headers },
    method: init.method,
    url: scheduleDevRoute,
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

const guard = { [scheduleDevHeader]: scheduleDevHeaderValue }

describe("Schedule dev endpoint", () => {
  it("rejects requests without the guard header or from another origin", async () => {
    const { middlewares, server } = fakeServer()
    await registerScheduleDevEndpoint(server)

    expect(await call(middlewares[0]!, { method: "GET" })).toMatchObject({ body: "Forbidden Schedule Dev request.", status: 403 })
    expect(await call(middlewares[0]!, { headers: { ...guard, origin: "https://attacker.test" }, method: "GET" })).toMatchObject({ status: 403 })
    expect(await call(middlewares[0]!, { body: "{}", headers: { ...guard, "content-type": "text/plain" }, method: "POST" })).toMatchObject({ status: 415 })
    expect(await call(middlewares[0]!, { headers: guard, method: "DELETE" })).toMatchObject({ status: 405 })
  })

  it("reports hosts without an in-process Nitro environment", async () => {
    const { middlewares, server } = fakeServer()
    await registerScheduleDevEndpoint(server)

    const discovery = await call(middlewares[0]!, { headers: guard, method: "GET" })
    expect(JSON.parse(discovery.body)).toEqual({ message: scheduleDevRuntimeUnavailableMessage, root: rootDir, runtime: "unavailable", scheduleDevTokenServerId: expect.any(String) })
    const metadata = JSON.parse((await call(middlewares[0]!, { headers: guard, method: "GET" })).body)
    const privateGuard = { ...guard, [scheduleDevTokenServerHeader]: metadata.scheduleDevTokenServerId, [viteHubDevTokenHeader]: (await readViteHubDevToken(rootDir, { namespace: scheduleDevTokenNamespace, serverId: metadata.scheduleDevTokenServerId }))! }
    const operation = await call(middlewares[0]!, { body: "{\"operation\":\"list\"}", headers: { ...privateGuard, "content-type": "application/json" }, method: "POST" })
    expect(operation.status).toBe(501)
    expect(JSON.parse(operation.body)).toMatchObject({ error: { code: "SCHEDULE_DEV_RUNTIME_UNAVAILABLE" } })
  })

  it("forwards operations into the Nitro environment under the Nitro base URL", async () => {
    const dispatchFetch = vi.fn(async (request: Request) => Response.json({ body: await request.text(), url: request.url }))
    const { middlewares, server } = fakeServer({ nitro: { dispatchFetch } })
    await registerScheduleDevEndpoint(server, { nitroBaseURL: () => "/app/" })

    expect(JSON.parse((await call(middlewares[0]!, { headers: guard, method: "GET" })).body)).toEqual({ root: rootDir, runtime: "nitro", scheduleDevTokenServerId: expect.any(String) })
    const metadata = JSON.parse((await call(middlewares[0]!, { headers: guard, method: "GET" })).body)
    const privateGuard = { ...guard, [scheduleDevTokenServerHeader]: metadata.scheduleDevTokenServerId, [viteHubDevTokenHeader]: (await readViteHubDevToken(rootDir, { namespace: scheduleDevTokenNamespace, serverId: metadata.scheduleDevTokenServerId }))! }
    const operation = await call(middlewares[0]!, { body: "{\"operation\":\"list\"}", headers: { ...privateGuard, "content-type": "application/json" }, method: "POST" })

    expect(operation.status).toBe(200)
    expect(operation.headers["cache-control"]).toBe("no-store")
    expect(JSON.parse(operation.body)).toEqual({ body: "{\"operation\":\"list\"}", url: `http://localhost/app${scheduleDevRuntimeRoute}` })
    expect(dispatchFetch.mock.calls[0]?.[0].headers.get(scheduleDevHeader)).toBe(scheduleDevHeaderValue)
  })

  it("revokes the Vite token as soon as the server starts closing", async () => {
    const { middlewares, server, httpServer } = fakeServer()
    await registerScheduleDevEndpoint(server)

    const discovery = JSON.parse((await call(middlewares[0]!, { headers: guard, method: "GET" })).body)
    const privateGuard = {
      ...guard,
      [scheduleDevTokenServerHeader]: discovery.scheduleDevTokenServerId,
      [viteHubDevTokenHeader]: (await readViteHubDevToken(rootDir, { namespace: scheduleDevTokenNamespace, serverId: discovery.scheduleDevTokenServerId }))!,
    }

    httpServer.emit("close")

    expect(await call(middlewares[0]!, { body: "{\"operation\":\"list\"}", headers: { ...privateGuard, "content-type": "application/json" }, method: "POST" })).toMatchObject({ body: "Forbidden Schedule Dev token.", status: 403 })
  })
})
