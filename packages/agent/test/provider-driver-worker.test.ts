import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import { parseAst } from "vite"

import { resolvesWorkerConditions, usesProviderAgentDriver } from "../src/internal/provider-driver-usage.ts"
import { createProviderAgentAdapter, inspectAgentProvider } from "../src/runtime/provider-agent-worker.ts"
import { hubAgent } from "../src/vite.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

async function transformServerModule(source: string, conditions: string[]) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-provider-worker-"))
  temporaryDirectories.push(root)
  const plugin = hubAgent()
  // SAFETY: The test supplies the resolved config fields that configResolved reads.
  await (plugin.configResolved as (config: unknown) => Promise<void>)({ command: "build", plugins: [], root })
  // SAFETY: hubAgent defines transform as a callable Vite hook; the context supplies the fields it reads.
  return await (plugin.transform as (...args: unknown[]) => Promise<string | undefined>).call(
    { environment: { config: { resolve: { conditions } } }, parse: parseAst },
    source,
    join(root, "server", "agents", "support.ts"),
  )
}

describe("provider Agent Drivers in Worker builds", () => {
  it.each([
    `import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: "codex" })`,
    `import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: 'claude-code' })`,
    `import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: { kind: "codex", permissions: "allow-edits" } })`,
    `import { codexDriver, defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: codexDriver({ model: "gpt-5" }) })`,
    `import { claudeCodeDriver, defineAgent } from "@vite-hub/agent"; export default defineAgent({ capabilities: [title({ driver: claudeCodeDriver() })], driver: { model: "openai/gpt-5" } })`,
    `import { codexDriver as makeDriver, defineAgent as define } from "@vite-hub/agent"; export default define({ driver: makeDriver() })`,
    `import * as agent from "@vite-hub/agent"; export default agent.defineAgent({ driver: agent.codexDriver() })`,
    `import workspace from "vite-hub/agent/presets/workspace"`,
    `import { babysitter } from "@vite-hub/agent/presets/babysitter"`,
  ])("finds a provider Driver in %s", (source) => {
    expect(usesProviderAgentDriver(source)).toBe(true)
  })

  it.each([
    `import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: { model: "openai/gpt-5" } })`,
    `import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: { run: () => "ok" } })`,
    `import { defineAgent } from "@vite-hub/agent"; const instructions = 'driver: "codex"'; export default defineAgent({ driver: { model: "openai/gpt-5" } })`,
    `import { defineAgent } from "@vite-hub/agent"; const url = "https://example.com//driver: \\\"codex\\\""; export default defineAgent({ driver: { model: "openai/gpt-5" } })`,
    `import { defineAgent } from "@vite-hub/agent"; const value = { kind: "codex" }; export default defineAgent({ driver: { run: () => "codex" } })`,
    `import { defineAgent } from "@vite-hub/agent"; const code = /codexDriver\\(\\)/; export default defineAgent({ driver: { run: () => "codex" } })`,
    `import type { codexDriver } from "@vite-hub/agent"; import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: { model: "openai/gpt-5" } })`,
    `import type { workspace } from "vite-hub/agent/presets/workspace"`,
  ])("ignores model and run Drivers in %s", (source) => {
    expect(usesProviderAgentDriver(source)).toBe(false)
  })

  it("detects Worker resolve conditions", () => {
    expect(resolvesWorkerConditions(["workerd", "worker"])).toBe(true)
    expect(resolvesWorkerConditions(["worker"])).toBe(true)
    expect(resolvesWorkerConditions(["node", "import"])).toBe(false)
    expect(resolvesWorkerConditions(undefined)).toBe(false)
  })

  it("fails a Worker build that selects a provider Driver", async () => {
    await expect(transformServerModule(`import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: "codex" })`, ["workerd", "worker"]))
      .rejects.toMatchObject({ code: "AGENT_B0019" })
    await expect(transformServerModule(`import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: "codex" })`, ["workerd", "worker"]))
      .rejects.toThrow(/cannot run in a Cloudflare Worker\. Used in server\/agents\/support\.ts\./)
  })

  it("keeps provider Drivers in Node builds and model Drivers in Worker builds", async () => {
    await expect(transformServerModule(`import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: "codex" })`, ["node", "import"])).resolves.toBeUndefined()
    await expect(transformServerModule(`import { defineAgent } from "@vite-hub/agent"; export default defineAgent({ driver: { model: "openai/gpt-5" } })`, ["workerd", "worker"])).resolves.toBeUndefined()
  })

  it("fails provider Driver calls that reach the Worker runtime", async () => {
    // SAFETY: The Worker module throws before it reads any option.
    expect(() => createProviderAgentAdapter({} as never)).toThrow(expect.objectContaining({ code: "AGENT_R0928" }))
    // SAFETY: The Worker module throws before it reads any option or context.
    expect(() => inspectAgentProvider({} as never, {} as never)).toThrow(/require a Node\.js host/)
  })
})
