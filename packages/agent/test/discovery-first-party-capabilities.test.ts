import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { discoverAgentDefinitions } from "../src/discovery.ts"

async function discover(source: string) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-capability-discovery-"))
  try {
    const folder = join(root, "server", "agents", "meals")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "agent.ts"), source)
    return discoverAgentDefinitions({ mode: "server-agents", scanDirs: [join(root, "server")] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it.each(["vite-hub/agent/capabilities", "@vite-hub/agent/capabilities"])("discovers a meal Agent using first-party storage, transcription, and usage: %s", async (module) => {
  const definitions = await discover(`import { blob, db, transcribe, usage } from "${module}"
    export default defineAgent({ capabilities: [blob({ mode: "write" }), db({ mode: "write" }), transcribe({ execute: () => "text" }), usage()] })`)
  expect(definitions[0]?.workspace).toBeUndefined()
  expect(definitions[0]?.name).toBe("meals")
})

it.each([
  'import { blob as storage } from "vite-hub/agent/capabilities"; const selected = storage({ mode: "write" });',
  'import * as capabilities from "vite-hub/agent/capabilities"; const selected = capabilities.blob({ mode: "write" });',
])("follows local aliases of first-party Capability calls: %s", async (setup) => {
  const definitions = await discover(`${setup} export default defineAgent({ capabilities: [selected] })`)
  expect(definitions[0]?.workspace).toBeUndefined()
})

it.each(["{}", "{ transcript: false, audio: false }"])("discovers transcription's required Workspace when artifacts are configured: %s", async (artifacts) => {
  const definitions = await discover(`import { transcribe } from "vite-hub/agent/capabilities";
    export default defineAgent({ capabilities: [transcribe({ execute: () => "text", artifacts: ${artifacts} })] })`)
  expect(definitions[0]?.workspace).toBe("meals")
})

it.each(["undefined", "void 0"])("keeps transcription without artifact settings free of Workspace ownership: %s", async (artifacts) => {
  const definitions = await discover(`import { transcribe } from "vite-hub/agent/capabilities";
    export default defineAgent({ capabilities: [transcribe({ execute: () => "text", artifacts: ${artifacts} })] })`)
  expect(definitions[0]?.workspace).toBeUndefined()
})

it.each([
  'get artifacts() { return {} }',
  'set artifacts(value) {}',
  '__proto__: { artifacts: {} }',
  '...{ get artifacts() { return {} } }',
  '...{ __proto__: { artifacts: {} } }',
])("rejects opaque transcription artifact settings: %s", async (settings) => {
  const source = `import { transcribe } from "vite-hub/agent/capabilities";
    export default defineAgent({ capabilities: [transcribe({ execute: () => "text", ${settings} })] })`
  await expect(discover(source)).rejects.toThrow("Agent Workspace discovery cannot inspect opaque transcription settings")
})

it("allows opaque transcription settings with explicit Workspace ownership", async () => {
  const definitions = await discover(`import { transcribe } from "vite-hub/agent/capabilities";
    export default defineAgent({ workspace: {}, capabilities: [transcribe({ execute: () => "text", get artifacts() { return {} } })] })`)
  expect(definitions[0]?.workspace).toBe("meals")
})

it.each([
  'import { blob } from "./capabilities"; export default defineAgent({ capabilities: [blob({})] })',
  'const blob = () => defineCapability({ workspace: {} }); export default defineAgent({ capabilities: [blob({})] })',
  'import { blob } from "vite-hub/agent/capabilities"; blob.extra = {}; export default defineAgent({ capabilities: [blob({})] })',
  'import { blob } from "vite-hub/agent/capabilities"; export default defineAgent({ options: {}, configure: blob => defineAgent({ capabilities: [blob({})] }) })',
  'import { blob } from "vite-hub/agent/capabilities"; export default defineAgent({ capabilities: [blob({}).custom()] })',
  'import { transcribe } from "vite-hub/agent/capabilities"; export default defineAgent({ capabilities: [transcribe(() => ({ artifacts: {} }))] })',
])("retains rejection of opaque or changed Capability calls: %s", async (source) => {
  await expect(discover(source)).rejects.toThrow("Agent Workspace discovery cannot inspect")
})
