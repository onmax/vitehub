import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createWorkflowCliContributor, parseWorkflowCliArgs, resolveWorkflowCliJsonValues, runWorkflowCli } from "../src/cli.ts"
import { workflowDevRuntimeUnavailableCode, workflowDevRuntimeUnavailableMessage } from "../src/dev-endpoint.ts"
import { workflowDevHeader } from "../src/dev-support.ts"
import { hubWorkflow } from "../src/vite.ts"

import type { WorkflowCliContext } from "../src/cli.ts"
import type { WorkflowDevDiscovery, WorkflowDevOperation } from "../src/dev-support.ts"

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "vitehub-workflow-cli-"))
})

afterEach(async () => {
  await rm(cwd, { force: true, recursive: true })
})

function createContext(env: NodeJS.ProcessEnv = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  const context: WorkflowCliContext = {
    cwd,
    env,
    rootDir: "/app",
    stderr: { write: chunk => stderr.push(String(chunk)) },
    stdout: { write: chunk => stdout.push(String(chunk)) },
  }
  return { context, stderr: () => stderr.join(""), stdout: () => stdout.join("") }
}

const nitroDiscovery: WorkflowDevDiscovery = { root: "/app", runtime: "nitro" }

function devServer(respond: (body: Record<string, unknown>) => Response, discovery: WorkflowDevDiscovery = nitroDiscovery) {
  const posts: Array<Record<string, unknown>> = []
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    expect(String(input)).toBe("http://localhost:5173/__vitehub/workflow/dev")
    expect(new Headers(init?.headers).get(workflowDevHeader)).toBe("1")
    if (init?.method !== "POST") return Response.json(discovery)
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    posts.push(body)
    return respond(body)
  })
  return { fetch, posts }
}

describe("workflow CLI arguments", () => {
  const parse = (operation: WorkflowDevOperation, args: string[]) => parseWorkflowCliArgs(operation, args, {})

  it("runs help and JSON argument errors through the executable entrypoint", async () => {
    await mkdir(join(cwd, "node_modules/@vite-hub"), { recursive: true })
    await symlink(resolve(import.meta.dirname, ".."), join(cwd, "node_modules/@vite-hub/workflow"), "dir")
    await writeFile(join(cwd, "vite.config.mjs"), 'import { hubWorkflow } from "@vite-hub/workflow/vite"; export default { plugins: [hubWorkflow({ provider: "vercel" })] };')
    const cli = resolve(import.meta.dirname, "../../cli/src/index.ts")
    const help = spawnSync(process.execPath, [cli, "workflow", "get", "--help"], { cwd, encoding: "utf8", timeout: 30_000 })
    expect(help.status).toBe(0)
    expect(help.stdout).toContain("vitehub workflow get")
    expect(help.stderr).toBe("")
    const invalid = spawnSync(process.execPath, [cli, "workflow", "get", "--json"], { cwd, encoding: "utf8", timeout: 30_000 })
    expect(invalid.status).toBe(1)
    expect(JSON.parse(invalid.stdout).error.message).toContain("run")
    expect(invalid.stderr).toBe("")
    const preload = join(cwd, "fetch.mjs")
    await writeFile(preload, `globalThis.fetch = async (_url, init) => {
      if (init?.method !== "POST") return Response.json({ root: process.cwd(), runtime: "nitro" });
      const request = JSON.parse(init.body);
      if (request.operation === "start" && request.input === -1) return Response.json({ run: { id: "negative-run", provider: "vercel", status: "queued", workflow: "welcome" } });
      if (request.operation === "resume" && request.payload === -1) return Response.json({ signal: { id: "negative-signal", provider: "vercel" } });
      throw new Error("The CLI changed the negative scalar.");
    };`)
    for (const [operation, target, flag] of [["start", "welcome", "--input"], ["resume", "tok", "--payload"]] as const) {
      const negative = spawnSync(process.execPath, ["--import", preload, cli, "workflow", operation, target, flag, "-1", "--json"], { cwd, encoding: "utf8", timeout: 30_000 })
      expect(negative.status).toBe(0)
      expect(JSON.parse(negative.stdout)).toEqual(operation === "start"
        ? { run: { id: "negative-run", provider: "vercel", status: "queued", workflow: "welcome" } }
        : { signal: { id: "negative-signal", provider: "vercel" } })
      expect(negative.stderr).toBe("")
    }
  })

  it("parses each command", () => {
    expect(parse("start", ["welcome", "--input", "{\"a\":1}", "--json"])).toEqual({
      help: false,
      json: true,
      operation: "start",
      pendingJson: { flag: "--input", value: "{\"a\":1}" },
      request: { operation: "start", workflow: "welcome" },
      url: "http://localhost:5173",
    })
    expect(parse("get", ["run-1", "--workflow=welcome", "--url", "http://127.0.0.1:4000", "--timeout=50"])).toMatchObject({
      request: { operation: "get", runId: "run-1", workflow: "welcome" },
      timeout: 50,
      url: "http://127.0.0.1:4000",
    })
    expect(parse("cancel", ["--workflow", "welcome", "run-2"]).request).toEqual({ operation: "cancel", runId: "run-2", workflow: "welcome" })
    expect(parse("resume", ["tok", "--payload={\"ok\":true}"])).toMatchObject({
      pendingJson: { flag: "--payload", value: "{\"ok\":true}" },
      request: { operation: "resume", token: "tok" },
    })
    expect(parseWorkflowCliArgs("get", ["run-1"], { VITEHUB_DEV_SERVER_URL: "http://127.0.0.1:9000" }).url).toBe("http://127.0.0.1:9000")
    expect(parse("get", ["--help"]).help).toBe(true)
  })

  it("rejects missing values, unknown options, and extra arguments with Workflow diagnostics", () => {
    expect(() => parse("start", [])).toThrow(expect.objectContaining({ code: "WORKFLOW_R0034", message: expect.stringContaining("Missing Workflow name.") }))
    expect(() => parse("get", [])).toThrow(expect.objectContaining({ message: expect.stringContaining("Missing run ID.") }))
    expect(() => parse("resume", [])).toThrow(expect.objectContaining({ message: expect.stringContaining("Missing signal token.") }))
    expect(() => parse("start", ["welcome", "--input"])).toThrow(expect.objectContaining({ code: "WORKFLOW_R0031", message: expect.stringContaining("Missing value for --input.") }))
    expect(() => parse("start", ["welcome", "--workflow", "x"])).toThrow(expect.objectContaining({ message: expect.stringContaining("Unknown option: --workflow.") }))
    expect(() => parse("resume", ["tok", "--input", "{}"])).toThrow(expect.objectContaining({ message: expect.stringContaining("Unknown option: --input.") }))
    expect(() => parse("get", ["a", "b"])).toThrow(expect.objectContaining({ message: expect.stringContaining("Unexpected argument: b.") }))
    expect(() => parse("get", ["a", "--timeout", "0"])).toThrow(expect.objectContaining({ code: "WORKFLOW_R0032" }))
    expect(() => parse("resume", ["run-1", "--signal", "approve"])).toThrow(expect.objectContaining({ message: expect.stringContaining("Workflow signals resume by token, not by run ID and signal name.") }))
  })

  it("reads JSON values inline or from a file relative to the working directory", async () => {
    await writeFile(join(cwd, "input.json"), "{\"from\":\"file\"}")
    const inline = await resolveWorkflowCliJsonValues(parseWorkflowCliArgs("start", ["welcome", "--input", "[1,2]"], {}), cwd)
    expect(inline.request).toEqual({ input: [1, 2], operation: "start", workflow: "welcome" })
    const file = await resolveWorkflowCliJsonValues(parseWorkflowCliArgs("resume", ["tok", "--payload", "@input.json"], {}), cwd)
    expect(file.request).toEqual({ operation: "resume", payload: { from: "file" }, token: "tok" })
    await expect(resolveWorkflowCliJsonValues(parseWorkflowCliArgs("start", ["welcome", "--input", "{bad"], {}), cwd))
      .rejects.toMatchObject({ code: "WORKFLOW_R0035", message: expect.stringContaining("Invalid JSON for --input") })
    await expect(resolveWorkflowCliJsonValues(parseWorkflowCliArgs("start", ["welcome", "--input", "@missing.json"], {}), cwd))
      .rejects.toMatchObject({ code: "WORKFLOW_R0035", message: expect.stringContaining("Cannot read --input file missing.json") })
  })
})

describe("workflow CLI commands", () => {
  it.each((["start", "resume"] as const).flatMap(operation =>
    ["-1", "-0.25", "-1e-3", "-1E+2", "-1 "].map(value => ({ operation, value })),
  ))("sends separate negative JSON scalars for $operation: $value", async ({ operation, value }) => {
    const output = createContext()
    const flag = operation === "start" ? "--input" : "--payload"
    const body = operation === "start"
      ? { run: { id: "run-1", provider: "vercel", status: "queued", workflow: "welcome" } }
      : { signal: { id: "signal-1", provider: "vercel", status: "resolved", token: "tok" } }
    const server = devServer(() => Response.json(body))
    expect(await runWorkflowCli(operation, [operation === "start" ? "welcome" : "tok", flag, value, "--json"], output.context, { fetch: server.fetch })).toBe(0)
    expect(server.posts).toEqual([operation === "start"
      ? { input: JSON.parse(value), operation, workflow: "welcome" }
      : { operation, payload: JSON.parse(value), token: "tok" }])
    expect(JSON.parse(output.stdout())).toEqual(body)
    expect(output.stderr()).toBe("")
  })

  it.each(["start", "resume"] as const)("validates malformed negative JSON for %s before discovery", async operation => {
    const output = createContext()
    const fetch = vi.fn()
    const flag = operation === "start" ? "--input" : "--payload"
    expect(await runWorkflowCli(operation, ["target", flag, "-1bad", "--json"], output.context, { fetch })).toBe(1)
    expect(JSON.parse(output.stdout()).error.message).toContain(`Invalid JSON for ${flag}`)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ["start", "--input", "--json"],
    ["start", "--input", "--url"],
    ["resume", "--payload", "--json"],
    ["get", "--workflow", "-1"],
    ["get", "--workflow", "--json"],
  ] as const)("preserves missing values for %s %s %s", async (operation, flag, next) => {
    const args = ["target", flag, next, "--json"]
    expect(() => parseWorkflowCliArgs(operation, args, {})).toThrow(expect.objectContaining({ code: "WORKFLOW_R0031" }))
    const output = createContext()
    const fetch = vi.fn()
    expect(await runWorkflowCli(operation, args, output.context, { fetch })).toBe(1)
    expect(JSON.parse(output.stdout()).error.code).toBe("WORKFLOW_INVALID_ARGUMENT")
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([{ run: { id: "bad" } }, { signal: { id: 42, provider: "vercel" } }])("rejects malformed operation views %j", async (body) => {
    const output = createContext()
    const server = devServer(() => Response.json(body))
    expect(await runWorkflowCli("get", ["run-1", "--json"], output.context, { fetch: server.fetch })).toBe(1)
    expect(JSON.parse(output.stdout()).error.code).toBe("WORKFLOW_DEV_FAILED")
  })

  it("starts a run and prints concise output with the runtime note", async () => {
    const note = "Runs the Workflow inline in the Nitro dev runtime, as the app does in development."
    const server = devServer(() => Response.json({ note, run: { id: "run-1", provider: "vercel", status: "queued", workflow: "welcome" } }))
    const output = createContext()
    await writeFile(join(cwd, "input.json"), "{\"name\":\"Ada\"}")
    expect(await runWorkflowCli("start", ["welcome", "--input", "@input.json"], output.context, { fetch: server.fetch })).toBe(0)
    expect(server.posts).toEqual([{ input: { name: "Ada" }, operation: "start", workflow: "welcome" }])
    expect(output.stdout()).toBe("Started run run-1 of workflow welcome (vercel, queued).\nCheck it with: vitehub workflow get run-1\n")
    expect(output.stderr()).toBe(`[workflow] ${note}\n`)
  })

  it("prints the endpoint body as JSON with --json", async () => {
    const run = { id: "run-1", provider: "vercel", result: { ok: true }, status: "completed", workflow: "welcome" }
    const server = devServer(() => Response.json({ note: "Reads inline runs.", run }))
    const output = createContext()
    expect(await runWorkflowCli("get", ["run-1", "--json"], output.context, { fetch: server.fetch })).toBe(0)
    expect(server.posts).toEqual([{ operation: "get", runId: "run-1" }])
    expect(JSON.parse(output.stdout())).toEqual({ note: "Reads inline runs.", run })
    expect(output.stderr()).toBe("")
  })

  it("prints run details in human output", async () => {
    const server = devServer(() => Response.json({
      run: { completedAt: "2026-09-29T10:00:00.000Z", id: "ow-1", provider: "openworkflow", result: { ok: true }, status: "completed", workflow: "welcome" },
    }))
    const output = createContext()
    expect(await runWorkflowCli("get", ["ow-1", "--workflow", "welcome"], output.context, { fetch: server.fetch })).toBe(0)
    expect(server.posts).toEqual([{ operation: "get", runId: "ow-1", workflow: "welcome" }])
    expect(output.stdout()).toContain("Run:       ow-1\nWorkflow:  welcome\nProvider:  openworkflow\nStatus:    completed\nCompleted: 2026-09-29T10:00:00.000Z\nResult:    {\n  \"ok\": true\n}\n")
  })

  it("prints unsupported operations that the Nitro dev runtime reports", async () => {
    const error = { error: { code: "WORKFLOW_DEV_UNSUPPORTED", message: "workflow cancel is not supported by the cloudflare provider. Cloudflare Workflows do not support cancellation through ViteHub." } }
    const server = devServer(() => Response.json(error, { status: 501 }))
    const human = createContext()
    expect(await runWorkflowCli("cancel", ["run-1", "--workflow", "welcome"], human.context, { fetch: server.fetch })).toBe(1)
    expect(human.stderr()).toBe(`${error.error.message}\n`)
    const json = createContext()
    expect(await runWorkflowCli("cancel", ["run-1", "--workflow", "welcome", "--json"], json.context, { fetch: server.fetch })).toBe(1)
    expect(JSON.parse(json.stdout())).toEqual(error)
  })

  it("explains hosts that cannot reach the Workflow runtime before it posts", async () => {
    const server = devServer(() => new Response("unexpected", { status: 500 }), { message: workflowDevRuntimeUnavailableMessage, root: "/app", runtime: "unavailable" })
    const human = createContext()
    expect(await runWorkflowCli("start", ["welcome"], human.context, { fetch: server.fetch })).toBe(1)
    expect(human.stderr()).toBe(`${workflowDevRuntimeUnavailableMessage}\n`)
    const json = createContext()
    expect(await runWorkflowCli("get", ["run-1", "--json"], json.context, { fetch: server.fetch })).toBe(1)
    expect(JSON.parse(json.stdout())).toEqual({ error: { code: workflowDevRuntimeUnavailableCode, message: workflowDevRuntimeUnavailableMessage } })
    expect(server.posts).toEqual([])
  })

  it("prints endpoint errors in human and JSON output", async () => {
    const error = { error: { code: "WORKFLOW_DEV_RUN_UNKNOWN", message: "Run run-9 was not started by `vitehub workflow start` in this Nitro dev runtime. Pass --workflow <name>." } }
    const server = devServer(() => Response.json(error, { status: 400 }))
    const human = createContext()
    expect(await runWorkflowCli("get", ["run-9"], human.context, { fetch: server.fetch })).toBe(1)
    expect(human.stderr()).toBe(`${error.error.message}\n`)
    const json = createContext()
    expect(await runWorkflowCli("get", ["run-9", "--json"], json.context, { fetch: server.fetch })).toBe(1)
    expect(JSON.parse(json.stdout())).toEqual(error)
  })

  it("reports a missing Vite Development Server", async () => {
    const output = createContext()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("fetch failed")
    })
    expect(await runWorkflowCli("get", ["run-1"], output.context, { fetch })).toBe(1)
    expect(output.stderr()).toBe("No Compatible Vite Development Server found at http://localhost:5173. Start the app with the Vite Development Server first.\n")
  })

  it("prints usage for --help and for invalid arguments", async () => {
    const help = createContext()
    expect(await runWorkflowCli("resume", ["--help"], help.context)).toBe(0)
    expect(help.stdout()).toContain("Usage: vitehub workflow resume <token> [--payload <json|@file>] [--json]")
    expect(help.stdout()).toContain("It does not reach deployed stages.")
    const invalid = createContext()
    expect(await runWorkflowCli("start", ["--nope"], invalid.context)).toBe(1)
    expect(invalid.stderr()).toContain("Unknown option: --nope.")
    expect(invalid.stderr()).toContain("Usage: vitehub workflow start <name>")
  })
})

describe("workflow CLI contributor", () => {
  it("contributes the workflow namespace from the Vite plugin", async () => {
    const cli = hubWorkflow().vitehub?.cli
    const contributor = typeof cli === "function" ? await cli() : cli
    expect(contributor?.namespaces[0]?.features.map(feature => feature.usage))
      .toEqual(createWorkflowCliContributor().namespaces[0]?.features.map(feature => feature.usage))
    expect(contributor?.namespaces.map(namespace => [namespace.name, namespace.features.map(feature => feature.name)])).toEqual([
      ["workflow", ["start", "get", "cancel", "resume"]],
    ])
  })
})
