import { execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"

const providerRuntimes = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const createProviderRuntime = vi.hoisted(() => vi.fn(async (_options: { environment?: Record<string, string>, settings?: Record<string, unknown> }) => providerRuntimes.shift()))
const createSqliteProviderRuntimeSessionStore = vi.hoisted(() => vi.fn(async (path: string) => ({
  close: vi.fn(),
  delete: vi.fn(async () => undefined),
  get: vi.fn(async () => undefined),
  path,
  set: vi.fn(async () => undefined),
})))

vi.mock("@t3tools/provider-runtime", () => ({ createProviderRuntime, createSqliteProviderRuntimeSessionStore }))

import { defineAgent, type AgentBoxDefinition, type AgentRuntimeConfig } from "../src/index.ts"
import { resolveAgentHealth } from "../src/health.ts"
import { boxSharesHostNetwork, providerBoxEnvironment } from "../src/internal/provider-box.ts"
import { createProviderAgentAdapter } from "../src/provider-agent.ts"

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  providerRuntimes.splice(0)
  createProviderRuntime.mockClear()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

interface PullRequestOptions {
  ref: string
  sha: string
  token: string
}

interface BoxTestInput {
  options: PullRequestOptions
  prompt: string
}

interface LauncherResult {
  code: number | null
  stderr: string
  stdout: string
}

/** Script that the provider command runs inside the Box. It reports what the provider can see. */
const probeScript = `
const { readFileSync } = require("node:fs")
let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => input += chunk)
process.stdin.on("end", () => {
  const home = process.env.HOME
  process.stdout.write(JSON.stringify({
    agents: readFileSync(home + "/.codex/AGENTS.md", "utf8"),
    argv: process.argv.slice(1),
    config: readFileSync(home + "/.config/tool.json", "utf8"),
    cwd: process.cwd(),
    env: {
      BOX_TOKEN: process.env.BOX_TOKEN,
      DRIVER_VALUE: process.env.DRIVER_VALUE,
      HOST_ONLY: process.env.VITEHUB_BOX_TEST_HOST_ONLY,
      RUNTIME_TOKEN: process.env.T3_MCP_BEARER_TOKEN,
    },
    home,
    input,
    readme: readFileSync("README.md", "utf8"),
  }))
  process.stderr.write("probe stderr\\n")
})
`

function event(type: string, threadId: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { payload, threadId, type, ...extra }
}

function providerRuntime(threadId: string, onStartSession: (input: { cwd: string }) => Promise<void>) {
  const value = {
    attachmentsDirectory: `/tmp/attachments-${crypto.randomUUID()}`,
    close: vi.fn(async () => undefined),
    events: {
      async *[Symbol.asyncIterator]() {
        yield event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })
      },
    },
    interruptTurn: vi.fn(async () => undefined),
    respondToRequest: vi.fn(async () => undefined),
    respondToUserInput: vi.fn(async () => undefined),
    sendTurn: vi.fn(async () => ({ threadId, turnId: "turn-1" })),
    startSession: vi.fn(async (input: { cwd: string }) => {
      await onStartSession(input)
      return { threadId }
    }),
    stopSession: vi.fn(async () => undefined),
  }
  providerRuntimes.push(value)
  return value
}

function invocationContext(threadId: string, input: BoxTestInput) {
  const values = new Map<string, unknown>()
  return {
    actor: { id: "actor" },
    context: {
      entries: () => values.entries(),
      get: (key: string) => values.get(key),
      has: (key: string) => values.has(key),
      set: (key: string, value: unknown) => values.set(key, value),
      toJSON: () => Object.fromEntries(values),
    },
    input,
    invoker: { id: "invoker", kind: "user" },
    messages: [],
    prompt: input.prompt,
    runtime: {
      memo: <T>(_key: string, create: () => T) => create(),
      run: { runId: `run-${threadId}`, threadId },
      runtime: "vite",
      runtimeConfig: {},
      waitUntil: () => undefined,
    },
  }
}

/** Start the launcher that the provider runtime receives as its provider binary. */
async function runLauncher(path: string, args: string[], options: { cwd: string, env: Record<string, string>, stdin: string }) {
  const child = spawn(path, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => stdout += chunk)
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr += chunk)
  child.stdin.end(options.stdin)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  return { code, stderr, stdout } satisfies LauncherResult
}

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-box-"))
  roots.push(root)
  return root
}

async function gitRepository(root: string) {
  const repository = join(root, "repository")
  await mkdir(repository)
  const git = (args: string[]) => execFileAsync("git", ["-C", repository, ...args])
  await git(["init", "--initial-branch=main"])
  await writeFile(join(repository, "README.md"), "first\n")
  await git(["add", "README.md"])
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "first"])
  const first = (await git(["rev-parse", "HEAD"])).stdout.trim()
  await git(["branch", "first"])
  await writeFile(join(repository, "README.md"), "second\n")
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-am", "second"])
  const second = (await git(["rev-parse", "HEAD"])).stdout.trim()
  return { first, repository, second }
}

type TestBox = AgentBoxDefinition<AgentRuntimeConfig, PullRequestOptions>

function testBox(repository: string, requires: TestBox["requires"] = []): TestBox {
  return {
    checkout: {
      ref: ({ input }) => input.options?.ref,
      remote: async () => repository,
      sha: ({ input }) => input.options?.sha,
    },
    env: { BOX_TOKEN: ({ input }) => input.options?.token },
    home: {
      files: {
        ".config/tool.json": { contents: ({ input }) => JSON.stringify({ sha: input.options?.sha }) },
      },
    },
    requires: ["git", ...requires],
    runtime: "trusted-host",
  }
}

describe("Agent Box definitions", () => {
  it("accepts a built-in provider Driver and exposes the Box definition", () => {
    const box = { runtime: "trusted-host" } as const
    const agent = defineAgent({ box, driver: { kind: "codex" } })
    expect(agent.box).toBe(box)
  })

  it.each([
    ["a Box without runtime", { box: {}, driver: { kind: "codex" } }, "AGENT_R0954"],
    ["a custom Driver", { box: { runtime: "trusted-host" }, driver: { run: () => "ok" } }, "AGENT_R0955"],
    ["driver.launch", { box: { runtime: "trusted-host" }, driver: { kind: "codex", launch: { command: "ssh" } } }, "AGENT_R0956"],
    ["driver.credentials", { box: { runtime: "trusted-host" }, driver: { credentials: () => "{}", kind: "codex" } }, "AGENT_R0957"],
    ["an Agent Workspace", { box: { runtime: "trusted-host" }, driver: { kind: "codex" }, workspace: {} }, "AGENT_R0958"],
  ])("rejects %s at definition time", (_name, options, code) => {
    // SAFETY: The invalid definitions exercise runtime validation for JavaScript callers.
    expect(() => defineAgent(options as never)).toThrow(expect.objectContaining({ code }))
  })

  it("keeps Agents without box unchanged", () => {
    const agent = defineAgent({ driver: { kind: "codex" } })
    expect(agent.box).toBeUndefined()
  })

  it("reports a configured Box in health checks", async () => {
    const withBox = await resolveAgentHealth({ box: { runtime: "trusted-host" }, name: "boxed" })
    const withoutBox = await resolveAgentHealth({ name: "plain" })
    expect(withBox.checks.box).toEqual({ status: "ready" })
    expect(withBox.integrations).toEqual({})
    expect(withoutBox.checks.box).toBeUndefined()
  })
})

describe("Agent Box environment", () => {
  it("forwards Driver and provider runtime values but keeps host values on the host", () => {
    expect(providerBoxEnvironment({
      explicit: ["DRIVER_VALUE", "PATH_OVERRIDE"],
      host: { HOST_SECRET: "host", PATH: "/host/bin" },
      prepared: { DRIVER_VALUE: "driver", PATH: "/host/bin", PATH_OVERRIDE: "/driver/bin" },
      received: {
        "BAD-NAME": "value",
        DRIVER_VALUE: "driver",
        HOME: "/host/home",
        HOST_SECRET: "host",
        PATH: "/host/bin",
        PATH_OVERRIDE: "/driver/bin",
        T3_MCP_BEARER_TOKEN: "runtime",
        XDG_CONFIG_HOME: "/host/config",
      },
    })).toEqual({ DRIVER_VALUE: "driver", PATH_OVERRIDE: "/driver/bin", T3_MCP_BEARER_TOKEN: "runtime" })
  })

  it("identifies runtimes that share the ViteHub network", () => {
    expect(boxSharesHostNetwork("trusted-host")).toBe(true)
    expect(boxSharesHostNetwork({ kind: "trusted-host" })).toBe(true)
    expect(boxSharesHostNetwork({ kind: "crabbox", network: "direct" })).toBe(true)
    expect(boxSharesHostNetwork({ kind: "crabbox", profile: "remote" })).toBe(false)
    expect(boxSharesHostNetwork("crabbox")).toBe(false)
  })
})

describe("Agent Box provider execution", () => {
  it("runs the provider in a Box resolved for each invocation", async () => {
    const root = await temporaryRoot()
    const { first, repository, second } = await gitRepository(root)
    vi.stubEnv("VITEHUB_BOX_TEST_HOST_ONLY", "host")
    const results: Array<{ launched: LauncherResult, localRoot: string }> = []
    const adapter = createProviderAgentAdapter<PullRequestOptions>({
      box: testBox(repository),
      env: { DRIVER_VALUE: "driver" },
      instructions: "Follow the Box rules.",
      provider: "codex",
      providerSettings: { binaryPath: process.execPath },
    })

    for (const [threadId, ref, sha, token] of [["box-first", "refs/heads/first", first, "token-a"], ["box-second", "refs/heads/main", second, "token-b"]] as const) {
      providerRuntime(threadId, async ({ cwd }) => {
        const options = createProviderRuntime.mock.lastCall?.[0]
        const launcher = String(options?.settings?.binaryPath)
        expect(launcher).not.toBe(process.execPath)
        const launched = await runLauncher(launcher, ["-e", probeScript, join(cwd, "notes.txt")], {
          cwd,
          env: { ...options?.environment, T3_MCP_BEARER_TOKEN: "runtime-token" },
          stdin: `{"path":"${cwd}/notes.txt"}\n`,
        })
        results.push({ launched, localRoot: cwd })
      })
      // SAFETY: The fixture provides the provider invocation fields read by the adapter.
      await adapter.generate(invocationContext(threadId, { prompt: "review", options: { ref, sha, token } }) as never)
    }

    expect(results).toHaveLength(2)
    const reports = results.map(({ launched }) => {
      expect(launched).toMatchObject({ code: 0, stderr: "probe stderr\n" })
      return JSON.parse(launched.stdout) as {
        agents: string
        argv: string[]
        config: string
        cwd: string
        env: Record<string, string | undefined>
        home: string
        input: string
        readme: string
      }
    })
    expect(reports.map(report => report.readme)).toEqual(["first\n", "second\n"])
    expect(reports.map(report => report.env.BOX_TOKEN)).toEqual(["token-a", "token-b"])
    expect(reports.map(report => JSON.parse(report.config).sha)).toEqual([first, second])
    for (const [index, report] of reports.entries()) {
      const localRoot = results[index]!.localRoot
      expect(report.agents).toContain("Follow the Box rules.")
      expect(report.env).toMatchObject({ DRIVER_VALUE: "driver", RUNTIME_TOKEN: "runtime-token" })
      expect(report.env.HOST_ONLY).toBeUndefined()
      expect(report.home).not.toBe(process.env.HOME)
      expect(report.cwd).not.toBe(localRoot)
      expect(report.argv).toEqual([`${report.cwd}/notes.txt`])
      expect(report.input).toBe(`{"path":"${report.cwd}/notes.txt"}\n`)
    }
    expect(reports[0]!.cwd).not.toBe(reports[1]!.cwd)
    await expect(readFile(join(reports[0]!.cwd, "README.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("reports the Box provider exit code and stderr as a launch failure", async () => {
    const root = await temporaryRoot()
    const { first, repository } = await gitRepository(root)
    const threadId = "box-failure"
    let launched: LauncherResult | undefined
    providerRuntime(threadId, async ({ cwd }) => {
      const options = createProviderRuntime.mock.lastCall?.[0]
      launched = await runLauncher(String(options?.settings?.binaryPath), ["-e", "process.stderr.write('box failed\\n'); process.exit(7)"], {
        cwd,
        env: { ...options?.environment },
        stdin: "",
      })
      throw new Error("Codex App Server process exited with code 7")
    })

    await expect(createProviderAgentAdapter<PullRequestOptions>({
      box: testBox(repository),
      provider: "codex",
      providerSettings: { binaryPath: process.execPath },
      // SAFETY: The fixture provides the provider invocation fields read by the adapter.
    }).generate(invocationContext(threadId, { prompt: "review", options: { ref: "refs/heads/first", sha: first, token: "token" } }) as never)).rejects.toMatchObject({
      code: "PROVIDER_LAUNCH_FAILED",
      details: { exitCode: 7, stderr: "box failed" },
    })
    expect(launched).toMatchObject({ code: 7, stderr: "box failed\n" })
  })

  it("checks Box requirements before the provider starts", async () => {
    const root = await temporaryRoot()
    const { first, repository } = await gitRepository(root)
    const runtime = providerRuntime("box-requires", async () => undefined)

    await expect(createProviderAgentAdapter<PullRequestOptions>({
      box: testBox(repository, ["vitehub-missing-box-command"]),
      provider: "codex",
      providerSettings: { binaryPath: process.execPath },
      // SAFETY: The fixture provides the provider invocation fields read by the adapter.
    }).generate(invocationContext("box-requires", { prompt: "review", options: { ref: "refs/heads/first", sha: first, token: "token" } }) as never)).rejects.toThrow("vitehub-missing-box-command")
    expect(runtime.startSession).not.toHaveBeenCalled()
  })
})
