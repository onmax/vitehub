import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { expect, it } from "vitest"

import { discoverAgentDefinitions } from "../src/discovery.ts"

// Writes `agent.ts` in server/agents/review and other files relative to server/.
async function discover(agent: string, files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-discovery-channel-helpers-"))
  try {
    const server = join(root, "server")
    const folder = join(server, "agents", "review")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "agent.ts"), agent)
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(server, path)), { recursive: true })
      await writeFile(join(server, path), source)
    }
    return discoverAgentDefinitions({ mode: "server-agents", scanDirs: [server] })[0]
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

const imports = 'import { defineAgent } from "vite-hub/agent"; import { github, telegram, webChat } from "vite-hub/agent/channels";'

it.each([
  "github()",
  "github({})",
  "github(undefined)",
  "github({ pullRequest: false, webhooks: true })",
  "github({ app: true, activity: true, pullRequest: false })",
  "github({ pullRequest: { workspace: false } })",
  "github({ pullRequest: { reply: false, workspace: false }, webhooks: { secretToken: \"secret\" } })",
  "github({ pullRequest: enabled })",
  "github(options)",
  "github({ ...options })",
  "github<Runtime>({ pullRequest: false })",
  "webChat()",
  "telegram({ mode: \"polling\" })",
  "webChat({ capabilities: [plain] })",
])("keeps an Agent with a stateless first-party Channel stateless: %s", async (channel) => {
  const source = `${imports} const enabled = false; const options = { pullRequest: false }; const plain = defineCapability({ id: "plain" }); export default defineAgent({ channels: { custom: ${channel} } })`
  const definition = await discover(source)
  expect(definition?.workspace).toBeUndefined()
  expect(definition?.source).toBe("server-agents")
})

it.each([
  "github({ pullRequest: true })",
  "github({ pullRequest: {} })",
  "github({ pullRequest: { workspace: true } })",
  "github({ pullRequest: { workspace: { mount: \"repo\" } } })",
  "github({ pullRequest: { reconcile: { events: [\"opened\"] } } })",
  "github({ pullRequest: dev ? { workspace: false } : true })",
  "github({ pullRequest: enabled })",
  "github({ pullRequest: false, capabilities: [storage] })",
  "webChat({ capabilities: [storage] })",
  "channels.github({ pullRequest: true })",
  "gh({ pullRequest: true })",
  "factory({ pullRequest: true })",
])("detects a first-party Channel that owns a Workspace: %s", async (channel) => {
  const source = `${imports} import * as channels from "@vite-hub/agent/channels"; import { github as gh } from "vite-hub/agent/channels"; const factory = github; const dev = process.env.DEV === "1"; const enabled = true; const storage = defineCapability({ workspace: {} }); export default defineAgent({ channels: { custom: ${channel} } })`
  const definition = await discover(source)
  expect(definition?.workspace).toBe("review")
  expect(definition?.source).toBe("server-agent-workspace")
})

it.each([
  "github({ __proto__: { pullRequest: true } })",
  "github({ pullRequest: { __proto__: { workspace: false } } })",
])("rejects prototype-backed Channel options: %s", async channel => {
  const source = `${imports} export default defineAgent({ channels: { custom: ${channel} } })`
  await expect(discover(source)).rejects.toThrow(/opaque Channel|dynamic GitHub pullRequest option/)
  const definition = await discover(source.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"))
  expect(definition?.workspace).toBe("review")
})

it.each([
  ["github({ pullRequest: options.pullRequest })", "dynamic GitHub pullRequest option"],
  ["github({ pullRequest: { workspace: options.workspace } })", "dynamic GitHub pullRequest option"],
  ["github({ pullRequest: flag || true })", "dynamic GitHub pullRequest option"],
  ["github(makeOptions())", "opaque Channel"],
  ["github({ ...makeOptions() })", "opaque Channel"],
  ["github({ capabilities: [imported] })", "imported Capability"],
])("rejects first-party Channel options that discovery cannot inspect: %s", async (channel, message) => {
  const source = `${imports} import { imported } from "./capabilities"; const options = { pullRequest: true, workspace: false }; const flag = false; const makeOptions = () => ({ pullRequest: true }); export default defineAgent({ channels: { custom: ${channel} } })`
  await expect(discover(source)).rejects.toThrow(message)
  const definition = await discover(source.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"))
  expect(definition?.workspace).toBe("review")
})

it("does not trust a Channel helper from another package or a shadowed helper", async () => {
  await expect(discover('import { github } from "other-package"; export default defineAgent({ channels: { github: github({ pullRequest: false }) } })')).rejects.toThrow("opaque Channel")
  await expect(discover(`${imports} export default defineAgent({ options: {}, configure: github => defineAgent({ channels: { github: github({ pullRequest: false }) } }) })`)).rejects.toThrow("opaque Channel")
})

const portalChannel = `import type { AgentChannelTriggerContext } from "vite-hub/agent"
import { github } from "vite-hub/agent/channels"

type Input = { payload?: unknown }

export default github({
  app: true,
  effects: { "comment-reaction": commentReactionEffect },
  pullRequest: false,
  triggers: { webhook: { invoke: invokeGitHubWebhook } },
  webhooks: true,
})

async function invokeGitHubWebhook(context: AgentChannelTriggerContext, input: Input) {
  return { input: { prompt: \`Review \${context.trigger.channelId}\`, context: { input } } }
}

async function commentReactionEffect() {}
`

it("inspects a first-party Channel imported from a relative module", async () => {
  const definition = await discover(
    'import { defineAgent } from "vite-hub/agent"\nimport portalGithub from "../../portal.github.ts"\nexport default defineAgent({ box: { runtime: { kind: "crabbox" } }, channels: { github: portalGithub }, driver: { kind: "codex" } })\n',
    { "portal.github.ts": portalChannel },
  )
  expect(definition?.workspace).toBeUndefined()
  expect(definition?.source).toBe("server-agents")
})

const stateless = 'import { github } from "vite-hub/agent/channels"; export default github({ pullRequest: false })'

it.each<[string, string, Record<string, string>]>([
  ["extensionless specifier", 'import portal from "../../portal"', { "portal.ts": stateless }],
  ["extensionless TSX specifier", 'import portal from "../../portal"', { "portal.tsx": stateless }],
  ["JavaScript specifier for a TypeScript file", 'import portal from "../../portal.js"', { "portal.ts": stateless }],
  ["JavaScript specifier for a TSX file", 'import portal from "../../portal.js"', { "portal.tsx": stateless }],
  ["directory index", 'import portal from "../../portal"', { "portal/index.ts": stateless }],
  ["exported declaration", 'import { portal } from "../../channels.ts"', { "channels.ts": 'import { github } from "vite-hub/agent/channels"; export const portal: Channel = github({ pullRequest: false })' }],
  ["export clause", 'import { channel as portal } from "../../channels.ts"', { "channels.ts": 'import { github } from "vite-hub/agent/channels"; const local = github({ pullRequest: false }); export { local as channel }' }],
  ["exported imported alias", 'import { portal } from "../../channels.ts"', { "channels.ts": 'import channel from "./inner.ts"; export { channel as portal }', "inner.ts": stateless }],
  ["re-exported import", 'import portal from "../../portal.ts"', { "portal.ts": 'import inner from "./inner.ts"; export default inner', "inner.ts": stateless }],
  ["forward export clause", 'import portal from "../../portal.ts"', { "portal.ts": 'import { github } from "vite-hub/agent/channels"; export { channel as default }; const channel = github({ pullRequest: false })' }],
  ["local alias", 'import imported from "../../portal.ts"; const portal = imported', { "portal.ts": stateless }],
])("resolves a relative Channel module: %s", async (_name, declaration, files) => {
  const definition = await discover(`import { defineAgent } from "vite-hub/agent"; ${declaration}; export default defineAgent({ channels: { github: portal } })`, files)
  expect(definition?.workspace).toBeUndefined()
})

it.each([
  ['import { github } from "vite-hub/agent/channels"; export default github({ pullRequest: true })'],
  ['import { github } from "vite-hub/agent/channels"; export default github({ pullRequest: { workspace: { mount: "repo" } } })'],
  ['import { defineCapability } from "vite-hub/agent"; import { defineChannel } from "vite-hub/agent/channels"; const storage = defineCapability({ workspace: {} }); export default defineChannel("custom", { capabilities: [storage] })'],
  ['export default { kind: "custom", capabilities: [defineCapability({ workspace: {} })] }'],
])("detects an imported Channel module that owns a Workspace: %s", async (channel) => {
  const definition = await discover('import portal from "../../portal.ts"; export default defineAgent({ channels: { github: portal } })', { "portal.ts": channel })
  expect(definition?.workspace).toBe("review")
})

it.each<[string, string, Record<string, string>]>([
  ["missing module", 'import portal from "../../missing.ts"', {}],
  ["package module", 'import portal from "@acme/channels"', {}],
  ["missing export", 'import { other as portal } from "../../portal.ts"', { "portal.ts": 'import { github } from "vite-hub/agent/channels"; export default github()' }],
  ["import cycle", 'import portal from "../../portal.ts"', { "portal.ts": 'import inner from "./inner.ts"; export default inner', "inner.ts": 'import portal from "./portal.ts"; export default portal' }],
  ["nested imported Capability", 'import portal from "../../portal.ts"', { "portal.ts": 'import { storage } from "./storage.ts"; export default { kind: "custom", capabilities: [storage] }' }],
  ["exported factory", 'import { portal } from "../../portal.ts"', { "portal.ts": 'export function portal() { return { kind: "custom" } }' }],
])("rejects an imported Channel that discovery cannot inspect: %s", async (_name, declaration, files) => {
  const source = `import { defineAgent } from "vite-hub/agent"; ${declaration}; export default defineAgent({ channels: { github: portal } })`
  await expect(discover(source, files)).rejects.toThrow(/cannot inspect (?:an imported Channel|an imported Capability|a local Channel factory)/)
  const definition = await discover(source.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"), files)
  expect(definition?.workspace).toBe("review")
})

it.each([
  "github({ get pullRequest() { return true } })",
  "github({ pullRequest: { get workspace() { return true } } })",
  "webChat({ get capabilities() { return [storage] } })",
  "github({ ...accessors })",
  "{ kind: \"custom\", get capabilities() { return [storage] } }",
])("rejects accessor-backed Channel options: %s", async (channel) => {
  const source = `${imports} const storage = defineCapability({ workspace: {} }); const accessors = { get pullRequest() { return true } }; export default defineAgent({ channels: { custom: ${channel} } })`
  await expect(discover(source)).rejects.toThrow(/opaque Channel|dynamic GitHub pullRequest option/)
  const definition = await discover(source.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"))
  expect(definition?.workspace).toBe("review")
})

it("keeps options named get or set as plain properties", async () => {
  const definition = await discover(`${imports} const get = false; export default defineAgent({ channels: { custom: github({ get, set: false, pullRequest: false }) } })`)
  expect(definition?.workspace).toBeUndefined()
})

const owning = 'import { github } from "vite-hub/agent/channels"; export default github({ pullRequest: true })'

it.each<[string, string, Record<string, string>, string | undefined]>([
  ["default re-export", 'import portal from "../../portal.ts"', { "portal.ts": 'export { default } from "./inner.ts"', "inner.ts": owning }, "review"],
  ["stateless default re-export", 'import portal from "../../portal.ts"', { "portal.ts": 'export { default } from "./inner.ts"', "inner.ts": stateless }, undefined],
  ["default re-exported as a name", 'import { portal } from "../../portal.ts"', { "portal.ts": 'export { default as portal } from "./inner.ts"', "inner.ts": owning }, "review"],
  ["name re-exported as default", 'import portal from "../../portal.ts"', { "portal.ts": 'export { channel as default } from "./inner.ts"', "inner.ts": 'import { github } from "vite-hub/agent/channels"; export const channel = github({ pullRequest: true })' }, "review"],
  ["forward local export", 'import portal from "../../portal.ts"', { "portal.ts": 'import { github } from "vite-hub/agent/channels"; export { channel as default }; const channel = github({ pullRequest: true })' }, "review"],
  ["string-literal default export", 'import portal from "../../portal.ts"', { "portal.ts": 'import { github } from "vite-hub/agent/channels"; const channel = github({ pullRequest: true }); export { channel as "default" }' }, "review"],
  ["string-literal default re-export", 'import portal from "../../portal.ts"', { "portal.ts": 'export { "default" as "default" } from "./inner.ts"', "inner.ts": owning }, "review"],
  ["star re-export", 'import { portal } from "../../portal.ts"', { "portal.ts": 'export * from "./other.ts"\nexport * from "./inner.ts"', "other.ts": "export const other = 1", "inner.ts": 'import { github } from "vite-hub/agent/channels"; export const portal = github({ pullRequest: true })' }, "review"],
  ["later declarator", 'import { portal } from "../../portal.ts"', { "portal.ts": 'import { github } from "vite-hub/agent/channels"; export const first = github(), portal = github({ pullRequest: true })' }, "review"],
  ["later declarator after a generic call", 'import { portal } from "../../portal.ts"', { "portal.ts": 'import { github } from "vite-hub/agent/channels"; export const map = new Map<string, number>(), portal = github({ pullRequest: true })' }, "review"],
  ["stateless later declarator", 'import { portal } from "../../portal.ts"', { "portal.ts": 'import { github } from "vite-hub/agent/channels"; export const first = github({ pullRequest: true }), portal = github()' }, undefined],
])("follows relative Channel exports: %s", async (_name, declaration, files, workspace) => {
  const definition = await discover(`import { defineAgent } from "vite-hub/agent"; ${declaration}; export default defineAgent({ channels: { github: portal } })`, files)
  expect(definition?.workspace).toBe(workspace)
})

it("records every local declarator", async () => {
  const definition = await discover(`${imports} const first = github(), portal = github({ pullRequest: true }); export default defineAgent({ channels: { github: portal } })`)
  expect(definition?.workspace).toBe("review")
})

it.each([
  'options.pullRequest = true',
  'options["pullRequest"] = true',
  'options.pullRequest.workspace = true',
  'options["pullRequest"]["workspace"] = true',
  'const alias = options; alias["pullRequest"] = true',
  'options.pullRequest ||= true',
  'options.pullRequest.workspace ||= true',
  'options.pullRequest ??= { workspace: true }',
  'options.pullRequest &&= { workspace: true }',
  'delete options.pullRequest.workspace',
  '++options.pullRequest.workspace',
  'options.pullRequest.workspace++',
  'delete (options.pullRequest.workspace)',
  'let alias; alias = options; alias.pullRequest = true',
  'let alias; alias = options; alias.pullRequest.workspace = true',
  'const pullRequest = options.pullRequest; pullRequest.workspace = true',
  'const { pullRequest: alias } = options; alias.workspace = true',
  'Object.assign(options, { pullRequest: true })',
  'Object["assign"](options, { pullRequest: true })',
  'Object.assign?.(options, { pullRequest: true })',
  'Object["assign"]((options), { pullRequest: true })',
  'Object.assign((options as Options), { pullRequest: true })',
  'Object.assign((options satisfies Options), { pullRequest: true })',
  'Object.assign((<Options>options), { pullRequest: true })',
  'Object.assign(options!, { pullRequest: true })',
  'Object.defineProperty(options, "pullRequest", { value: true })',
  'const enable = value => { value.pullRequest = true }; enable(options)',
  'function enable(value) { value.pullRequest = true }; enable(options)',
  'const enable = (flag, value) => { value.pullRequest = flag }; enable(true, options)',
  'const enable = value => { value.pullRequest = true }; enable((options as Options))',
  'const enable = value => { value.pullRequest = true }; const alias = options; enable(alias)',
  'const enable = value => { value.pullRequest = true }; const alias = options as Options; enable(alias)',
  'const enable = value => { value.workspace = true }; enable(options.pullRequest)',
  'const enable = value => { value.workspace = true }; const alias = options.pullRequest; enable(alias)',
  'const enable = value => { value.options.pullRequest = true }; enable({ options })',
  'import { enable } from "./mutator"; enable(options)',
  '(value => { value.pullRequest = true })(options)',
  '({ enable(value) { value.pullRequest = true } }).enable(options)',
])("rejects mutated Channel option bindings: %s", async (mutation) => {
  const source = `${imports} const options = { pullRequest: { workspace: false } }; ${mutation}; export default defineAgent({ channels: { custom: github(options) } })`
  await expect(discover(source)).rejects.toThrow("opaque Channel")
  const definition = await discover(source.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"))
  expect(definition?.workspace).toBe("review")
})

it("rejects a reassigned relative Channel export", async () => {
  const source = 'import { defineAgent } from "vite-hub/agent"; import portal from "../../portal.ts"; export default defineAgent({ channels: { github: portal } })'
  const files = { "portal.ts": 'import { github } from "vite-hub/agent/channels"; export let portal = github({ pullRequest: false }); portal = github({ pullRequest: true })' }
  await expect(discover(source, files)).rejects.toThrow("cannot inspect an imported Channel")
  const definition = await discover(source.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"), files)
  expect(definition?.workspace).toBe("review")
})

it.each([
  'options.pullRequest <= true',
  'options.pullRequest >= true',
  'const unused = { read(options) { return options.pullRequest } }',
])("does not treat read-only expressions as mutated Channel option bindings: %s", async (comparison) => {
  const source = `${imports} const options = { pullRequest: false }; ${comparison}; export default defineAgent({ channels: { custom: github(options) } })`
  const definition = await discover(source)
  expect(definition?.workspace).toBeUndefined()
})

it.each<[string, string, Record<string, string>]>([
  ["package re-export", 'import portal from "../../portal.ts"', { "portal.ts": 'export { default } from "@acme/channels"' }],
  ["package star re-export", 'import { portal } from "../../portal.ts"', { "portal.ts": 'export * from "@acme/channels"' }],
  ["missing re-exported module", 'import portal from "../../portal.ts"', { "portal.ts": 'export { default } from "./missing.ts"' }],
  ["default through a star re-export", 'import portal from "../../portal.ts"', { "portal.ts": 'export * from "./inner.ts"', "inner.ts": owning }],
  ["re-export cycle", 'import portal from "../../portal.ts"', { "portal.ts": 'export { default } from "./inner.ts"', "inner.ts": 'export { default } from "./portal.ts"' }],
  ["star re-export cycle", 'import { portal } from "../../portal.ts"', { "portal.ts": 'export * from "./inner.ts"', "inner.ts": 'export * from "./portal.ts"' }],
])("rejects a re-exported Channel that discovery cannot inspect: %s", async (_name, declaration, files) => {
  const source = `import { defineAgent } from "vite-hub/agent"; ${declaration}; export default defineAgent({ channels: { github: portal } })`
  await expect(discover(source, files)).rejects.toThrow("cannot inspect an imported Channel")
  const definition = await discover(source.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"), files)
  expect(definition?.workspace).toBe("review")
})
