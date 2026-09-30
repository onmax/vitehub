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
  ['channels', 'export default { review: github({ pullRequest: true }) }'],
  ['{ channels }', 'export const channels = { review: github({ pullRequest: true }) }'],
])("rejects relative Channel-map imports: %s", async (binding, declaration) => {
  const source = `${imports} import ${binding} from "../../channels"; export default defineAgent({ channels })`
  const files = { "channels.ts": `import { github } from "vite-hub/agent/channels"; ${declaration}` }
  await expect(discover(source, files)).rejects.toThrow(/opaque Channel|cannot inspect an imported Channel/)
  await expect(discover(source.replace("defineAgent({ channels })", "defineAgent({ channels: { ...channels } })"), files)).rejects.toThrow("cannot inspect an imported Channel")
  const definition = await discover(source.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"), files)
  expect(definition?.workspace).toBe("review")
})

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
  ["false ? true : false", false],
  ["true ? false : true", false],
  ["false ? true ? true : true : false", false],
  ["true ? true : false", true],
  ["{ workspace: false ? true : false }", false],
  ["{ workspace: true ? false : true }", false],
  ["{ workspace: true ? true : false }", true],
  ["(false) ? true : false", false],
  ["(true) ? false : true", false],
  ["((true)) ? (false) ? true : false : true", false],
  ["(false) ? false : true", true],
  ["{ workspace: ((true)) ? false : true }", false],
  ["{ workspace: (true) ? true : false }", true],
])("ignores unreachable conditional pullRequest branches: %s", async (pullRequest, ownsWorkspace) => {
  const channel = `github({ pullRequest: ${pullRequest} })`
  const definition = await discover(`${imports} export default defineAgent({ channels: { custom: ${channel} } })`)
  expect(definition?.workspace).toBe(ownsWorkspace ? "review" : undefined)
  const imported = await discover('import portal from "../../portal.ts"; export default defineAgent({ channels: { custom: portal } })', {
    "portal.ts": `${imports} export default ${channel}`,
  })
  expect(imported?.workspace).toBe(ownsWorkspace ? "review" : undefined)
})

it.each([
  'const { options: alias } = getOptions(); alias.pullRequest = true',
  'const { nested: { options: alias } } = getOptions(); alias.pullRequest = true',
  'const [alias] = getOptions(); alias.pullRequest = true',
  'const other = 1, { options: alias } = getOptions(); alias.pullRequest = true',
  'const { options: alias } = (getOptions()); const next = alias; next.pullRequest = true',
  'const { enable } = getOptions(); enable()',
])("rejects mutations through destructured opaque call results: %s", async mutation => {
  const setup = `${imports} const options = { pullRequest: false }; const getOptions = () => ({ options }); ${mutation};`
  await expect(discover(`${setup} export default defineAgent({ channels: { custom: github(options) } })`)).rejects.toThrow(/opaque Channel/)
  await expect(discover('import portal from "../../portal.ts"; export default defineAgent({ channels: { custom: portal } })', {
    "portal.ts": `${setup} export default github(options)`,
  })).rejects.toThrow(/opaque Channel/)
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
  '{ id: "storage", workspace: {} }',
  '({ id: "storage", workspace: {} })',
  '({ id: "storage", workspace: {} } as Capability)',
  'storage',
  '{ id: "combined", capabilities: [{ id: "storage", workspace: {} }] }',
  '{ id: "storage", ...contribution }',
])("detects literal Capability Workspace ownership: %s", async capability => {
  const setup = `${imports} const storage = { id: "storage", workspace: {} }; const contribution = { workspace: {} };`
  const settings = [
    `channels: { custom: webChat({ capabilities: [${capability}] }) }`,
    `capabilities: [${capability}]`,
  ]
  for (const setting of settings) {
    const definition = await discover(`${setup} export default defineAgent({ ${setting} })`)
    expect(definition?.workspace).toBe("review")
  }
  const imported = await discover('import portal from "../../portal.ts"; export default defineAgent({ channels: { custom: portal } })', {
    "portal.ts": `${setup} export default webChat({ capabilities: [${capability}] })`,
  })
  expect(imported?.workspace).toBe("review")
})

it.each([
  '{ id: "plain" }',
  '{ id: "plain", workspace: undefined }',
  'plain',
])("keeps literal stateless Capabilities stateless: %s", async capability => {
  const definition = await discover(`${imports} const plain = { id: "plain" }; export default defineAgent({ channels: { custom: webChat({ capabilities: [${capability}] }) } })`)
  expect(definition?.workspace).toBeUndefined()
})

it.each([
  '{ id: "storage", get workspace() { return {} } }',
  '({ id: "storage", workspace: {} }).other',
  '{ id: "storage", ...getContribution() }',
])("rejects opaque literal Capability ownership: %s", async capability => {
  const source = `${imports} export default defineAgent({ channels: { custom: webChat({ capabilities: [${capability}] }) } })`
  await expect(discover(source)).rejects.toThrow(/opaque Channel|opaque Capability|opaque Agent settings/)
  const explicit = await discover(source.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"))
  expect(explicit?.workspace).toBe("review")
})

it.each([
  ["{ pullRequest: false }", false],
  ["{ pullRequest: true }", true],
  ["{ pullRequest: { workspace: false } }", false],
  ["{ pullRequest: { workspace: {} } }", true],
  ['{ kind: "custom", pullRequest: true }', false],
  ['defineChannel("custom", { pullRequest: true })', false],
])("applies GitHub ownership to built-in channel options: %s", async (options, ownsWorkspace) => {
  const source = `${imports} export default defineAgent({ channels: { github: ${options} } })`
  const definition = await discover(source)
  expect(definition?.workspace).toBe(ownsWorkspace ? "review" : undefined)
  const imported = await discover('import options from "../../options.ts"; export default defineAgent({ channels: { github: options } })', {
    "options.ts": `${imports} export default ${options}`,
  })
  expect(imported?.workspace).toBe(ownsWorkspace ? "review" : undefined)
})

it.each([
  "<T = unknown>() => T",
  "string",
  "{ value: string }",
])("records Channels after uninitialized typed declarators: %s", async annotation => {
  const declaration = `let unused: ${annotation}, portal = github({ pullRequest: true });`
  const local = await discover(`${imports} ${declaration} export default defineAgent({ channels: { github: portal } })`)
  expect(local?.workspace).toBe("review")
  const imported = await discover('import { portal } from "../../portal.ts"; export default defineAgent({ channels: { github: portal } })', {
    "portal.ts": `${imports} export ${declaration}`,
  })
  expect(imported?.workspace).toBe("review")
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

it.each([
  '{ kind: "custom", capabilities: [], ...extra }',
  'defineChannel("custom", { capabilities: [], ...extra })',
])("rejects opaque generic Channel option spreads: %s", async channel => {
  const source = `${imports} import { defineChannel } from "vite-hub/agent/channels"; import { defineCapability } from "vite-hub/agent"; const storage = defineCapability({ workspace: {} }); const makeOptions = () => ({ capabilities: [storage] }); const extra = makeOptions(); export default defineAgent({ channels: { custom: ${channel} } })`
  await expect(discover(source)).rejects.toThrow("opaque Channel")
  const definition = await discover(source.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"))
  expect(definition?.workspace).toBe("review")
  const stateless = await discover(source.replace("const extra = makeOptions()", 'const extra = { kind: "custom" }'))
  expect(stateless?.workspace).toBeUndefined()
})

it("does not trust a Channel helper from another package or a shadowed helper", async () => {
  await expect(discover('import { github } from "other-package"; export default defineAgent({ channels: { github: github({ pullRequest: false }) } })')).rejects.toThrow("opaque Channel")
  await expect(discover(`${imports} export default defineAgent({ options: {}, configure: github => defineAgent({ channels: { github: github({ pullRequest: false }) } }) })`)).rejects.toThrow("opaque Channel")
})

it.each([
  'const { github: gh = channels.github } = channels; export default defineAgent({ channels: { github: gh({ pullRequest: true }) } })',
  'const { github: gh = custom(), telegram: tg = custom() } = channels; export default defineAgent({ channels: { github: gh({ pullRequest: true }), telegram: tg() } })',
  'const { github: gh } = channels; export default defineAgent({ channels: { github: gh({ pullRequest: true }) } })',
  'const { github: gh } = channels\nexport default defineAgent({ channels: { github: gh({ pullRequest: true }) } })',
  'const { github: gh, telegram: tg } = channels; export default defineAgent({ channels: { github: gh({ pullRequest: true }), telegram: tg() } })',
  'const [gh] = [github]; export default defineAgent({ channels: { github: gh({ pullRequest: true }) } })',
])("infers Workspace ownership through destructured Channel helpers: %s", async declaration => {
  const source = `${imports} import * as channels from "vite-hub/agent/channels"; ${declaration}`
  const definition = await discover(source)
  expect(definition?.workspace).toBe("review")
  const stateless = await discover(source.replace("pullRequest: true", "pullRequest: false"))
  expect(stateless?.workspace).toBeUndefined()
  for (const enabled of [true, false]) {
    const imported = await discover('import channel from "../../channel.ts"; export default defineAgent({ channels: { custom: channel } })', {
      "channel.ts": `${source.split("export default")[0]} export default gh({ pullRequest: ${enabled} })`,
    })
    expect(imported?.workspace).toBe(enabled ? "review" : undefined)
  }
})

it.each([
  'import * as channels from "other-package"; const { github: gh } = channels;',
  'import * as channels from "vite-hub/agent/channels"; const channels = { github: custom }; const { github: gh } = channels;',
  'import * as channels from "vite-hub/agent/channels"; let { github: gh } = channels; gh = custom;',
  'const [gh] = [custom];',
  'import * as channels from "vite-hub/agent/channels"; const { custom: github } = channels; const gh = github;',
  'import * as channels from "vite-hub/agent/channels"; const { github: gh } = channels && custom;',
  'const { github: gh } = [github];',
  'const [gh] = [github]; gh = custom;',
])("does not trust opaque or mutated destructured Channel helpers: %s", async declaration => {
  await expect(discover(`${imports} ${declaration} export default defineAgent({ channels: { custom: gh({ pullRequest: false }) } })`)).rejects.toThrow("opaque Channel")
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

it.each([
  ["[portal]", "aliases[0]"],
  ["{ portal }", "aliases.portal"],
  ["{ channel: portal }", "aliases.channel"],
  ['{ ["channel"]: portal }', "aliases.channel"],
  ['{ ["chan" + "nel"]: portal }', "aliases.channel"],
  ["Object.freeze({ channel: portal })", "aliases.channel"],
  ["Object.freeze([portal])", "aliases[0]"],
  ["[{ channel: portal }]", "aliases[0].channel"],
  ["{ nested: [portal] }", "aliases.nested[0]"],
  ["({ channel: (portal as Channel) })", "aliases.channel"],
  ["[flag ? portal : portal]", "aliases[0]"],
  ["[portal || portal]", "aliases[0]"],
  ["{ channel: flag ? portal : portal }", "aliases.channel"],
  ["[...single]", "aliases[0]"],
  ["{ ...singleObject }", "aliases.channel"],
])("rejects a relative Channel mutated through a container alias: %s", async (container, member) => {
  const definition = 'import { portal } from "../../portal.ts"; export default defineAgent({ channels: { github: portal } })'
  const portal = `${imports} const storage = defineCapability({ workspace: {} }); export const portal = github({ pullRequest: false }); const flag = false; const single = [portal]; const singleObject = { channel: portal }; const aliases = ${container};`
  const unchanged = await discover(definition, { "portal.ts": portal })
  expect(unchanged?.workspace).toBeUndefined()
  for (const mutation of [`${member}.capabilities = [storage]`, `const other = aliases; ${member.replace("aliases", "other")}.capabilities = [storage]`]) {
    const files = { "portal.ts": `${portal} ${mutation};` }
    await expect(discover(definition, files)).rejects.toThrow("opaque Channel")
    const explicit = await discover(definition.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"), files)
    expect(explicit?.workspace).toBe("review")
  }
})

it.each([
  ["Object.freeze({ options })", "wrapper.options"],
  ["Object.freeze([options])", "wrapper[0]"],
  ['{ ["options"]: options }', "wrapper.options"],
  ["[{ options }]", "wrapper[0].options"],
])("rejects Channel option mutations through wrapped containers: %s", async (container, member) => {
  const setup = `${imports} const options = { pullRequest: false }; const wrapper = ${container};`
  const definition = 'export default defineAgent({ channels: { github: github(options) } })'
  const unchanged = await discover(`${setup} ${definition}`)
  expect(unchanged?.workspace).toBeUndefined()
  const source = `${setup} ${member}.pullRequest = true; ${definition}`
  await expect(discover(source)).rejects.toThrow("opaque Channel")
  const explicit = await discover(source.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"))
  expect(explicit?.workspace).toBe("review")
})

it.each([
  "[options][0]",
  "({ options }).options",
  "[{ options }][0].options",
  "({ nested: [options] }).nested[0]",
  "([options])[0]",
  "(([options]))[0]",
])("rejects Channel option mutations through inline containers: %s", async receiver => {
  const setup = `${imports} const options = { pullRequest: false };`
  const definition = 'export default defineAgent({ channels: { github: github(options) } })'
  const unchanged = await discover(`${setup} ${receiver}.pullRequest === false; ${definition}`)
  expect(unchanged?.workspace).toBeUndefined()
  for (const mutation of [
    `${receiver}.pullRequest = true`,
    `${receiver}.pullRequest ||= true`,
    `${receiver}.pullRequest++`,
    `++${receiver}.pullRequest`,
    `delete ${receiver}.pullRequest`,
    `${receiver}.enable()`,
  ]) {
    const source = `${setup} ${mutation}; ${definition}`
    await expect(discover(source)).rejects.toThrow("opaque Channel")
    const explicit = await discover(source.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"))
    expect(explicit?.workspace).toBe("review")
  }
})

it.each([
  "[options].push(other)",
  "[options].pop()",
  "[options].shift()",
  "([options]).reverse()",
  "[options][0] = other",
  "delete [options][0]",
  "[options].length = 0",
  "({ options }).options = other",
  "delete ({ options }).options",
  "({ options }).toString()",
  "[options, other][1].pullRequest = true",
  "[options, other][1].enable()",
  '[options, other]["1"].enable()',
  "({ options, other }).other.pullRequest = true",
  '({ options, other })["other"].enable()',
])("keeps temporary container operations stateless: %s", async operation => {
  const definition = await discover(`${imports} const options = { pullRequest: false }; const other = {}; ${operation}; export default defineAgent({ channels: { github: github(options) } })`)
  expect(definition?.workspace).toBeUndefined()
  const imported = await discover('import portal from "../../portal.ts"; export default defineAgent({ channels: { github: portal } })', {
    "portal.ts": `${imports} const options = { pullRequest: false }; const other = {}; ${operation}; export default github(options)`,
  })
  expect(imported?.workspace).toBeUndefined()
})

it.each([
  "[portal][0]",
  "({ portal }).portal",
  "([{ portal }])[0].portal",
])("rejects relative Channel mutations through inline containers: %s", async receiver => {
  const files = {
    "portal.ts": `${imports} export const portal = github({ pullRequest: false }); ${receiver}.capabilities = []`,
  }
  const source = 'import { defineAgent } from "vite-hub/agent"; import { portal } from "../../portal.ts"; export default defineAgent({ channels: { github: portal } })'
  await expect(discover(source, files)).rejects.toThrow("opaque Channel")
  const explicit = await discover(source.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"), files)
  expect(explicit?.workspace).toBe("review")
})

it.each([
  "webChat({ capabilities: [storage] })",
  "github({ pullRequest: false, capabilities: [storage] })",
  '{ kind: "custom", capabilities: [storage] }',
])("rejects reassigned Capability bindings in Channel options: %s", async channel => {
  const setup = `${imports} let storage = defineCapability({}); storage = defineCapability({ workspace: {} });`
  const definition = `export default defineAgent({ channels: { custom: ${channel} } })`
  const source = `${setup} ${definition}`
  await expect(discover(source)).rejects.toThrow("mutable Capability")
  await expect(discover('import portal from "../../portal.ts"; export default defineAgent({ channels: { custom: portal } })', {
    "portal.ts": `${setup} export default ${channel}`,
  })).rejects.toThrow("mutable Capability")
  const explicit = await discover(source.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"))
  expect(explicit?.workspace).toBe("review")
})

it("rejects a Channel Capability list changed by a receiver call", async () => {
  const source = `${imports} const capabilities = []; capabilities.push(defineCapability({ workspace: {} })); export default defineAgent({ channels: { custom: webChat({ capabilities }) } })`
  await expect(discover(source)).rejects.toThrow("mutable Capability")
  const explicit = await discover(source.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"))
  expect(explicit?.workspace).toBe("review")
})

it.each([
  ['"review-channel"', "review-channel"], ["'review-channel'", "review-channel"], ['""', ""],
  ['"review-\\u0063hannel"', "review-channel"],
  [String.raw`'review\'channel'`, "review'channel"], [String.raw`"review\'channel"`, "review'channel"],
  [String.raw`'review\x2dchannel'`, "review-channel"], [String.raw`"review\u{2d}channel"`, "review-channel"],
  [String.raw`'review\channel'`, "reviewchannel"], [`'review"channel'`, 'review"channel'],
])("resolves string-named relative Channel imports: %s", async (exportedName, plainName) => {
  for (const pullRequest of [false, true]) {
    const source = `import { ${exportedName} as portal } from "../../portal.ts"; export default defineAgent({ channels: { github: portal } })`
    const channel = `${imports} const channel = github({ pullRequest: ${pullRequest} }); export { channel as ${JSON.stringify(plainName)} };`
    const direct = await discover(source, { "portal.ts": channel })
    expect(direct?.workspace).toBe(pullRequest ? "review" : undefined)
    const reExported = await discover(source, {
      "portal.ts": `export { ${exportedName} } from "./inner.ts"`,
      "inner.ts": channel,
    })
    expect(reExported?.workspace).toBe(pullRequest ? "review" : undefined)
    const aliased = await discover('import { barrel as portal } from "../../portal.ts"; export default defineAgent({ channels: { github: portal } })', {
      "portal.ts": `export { ${exportedName} as barrel } from "./inner.ts"`,
      "inner.ts": channel,
    })
    expect(aliased?.workspace).toBe(pullRequest ? "review" : undefined)
  }
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
  'for (const alias of [options]) alias.pullRequest = true',
  'const container = [options]; for (const alias of container) alias.pullRequest = true',
  'const container = [options]; const iterable = container; for (const alias of iterable) alias.pullRequest = true',
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
  '(options).pullRequest = true',
  '((options)).pullRequest = true',
  '(options as Options).pullRequest = true',
  '(options satisfies Options).pullRequest.workspace = true',
  '(options.pullRequest).workspace = true',
  '(options!).pullRequest = true',
  'const enable = value => { value.pullRequest = true }; enable(options)',
  'function enable(value) { value.pullRequest = true }; enable(options)',
  'const enable = (flag, value) => { value.pullRequest = flag }; enable(true, options)',
  'const enable = value => { value.pullRequest = true }; enable((options as Options))',
  'const enable = value => { value.pullRequest = true }; const alias = options; enable(alias)',
  'const enable = value => { value.pullRequest = true }; const alias = options as Options; enable(alias)',
  'const alias: typeof options = options; alias.pullRequest = true',
  'const [alias] = [options]; alias.pullRequest = true',
  'const { value: alias } = { value: options }; alias.pullRequest = true',
  'const [{ value: alias }] = [{ value: options }]; alias.pullRequest = true',
  'const container = [options]; const [alias] = container; alias.pullRequest = true',
  'const [alias = options] = []; alias.pullRequest = true',
  'const { value: alias = options } = {}; alias.pullRequest = true',
  'const [{ value: alias = options } = {}] = []; alias.pullRequest = true',
  'const [alias = (options)] = []; alias.pullRequest = true',
  'const flag = false; const [alias = flag ? options : options] = []; alias.pullRequest = true',
  'for (const [alias] of [[options]]) alias.pullRequest = true',
  'const iterable = [[options]]; for (const [alias] of iterable) alias.pullRequest = true',
  'const iterable = [{ value: options }]; for (const { value: alias } of iterable) alias.pullRequest = true',
  'const container = [{ value: options }]; const iterable = container; for (const { value: alias } of iterable) alias.pullRequest = true',
  'const alias: Options = options; alias.pullRequest.workspace = true',
  'const alias: { pullRequest: { workspace: boolean } } = options; alias.pullRequest.workspace = true',
  'const alias: typeof options = options; mutate(alias)',
  'const alias: typeof options & { <T = unknown>(): T } = options as typeof options & { <T = unknown>(): T }; alias.pullRequest.workspace = true',
  'const alias: typeof options & (<T = unknown>() => T) = options as typeof options & (<T = unknown>() => T); alias.pullRequest.workspace = true',
  'const alias: typeof options & (<T = unknown>() => T) = options as typeof options & (<T = unknown>() => T); mutate(alias)',
  'const alias: <T = unknown>() => T = options as unknown as <T = unknown>() => T; mutate(alias)',
  'const alias: <T = unknown>() => { value: T } = options as unknown as <T = unknown>() => { value: T }; mutate(alias)',
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
  await expect(discover(source, files)).rejects.toThrow(/opaque Channel|cannot inspect an imported Channel/)
  const definition = await discover(source.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"), files)
  expect(definition?.workspace).toBe("review")
})

it.each([
  'for (const alias of [portal]) alias.capabilities = []',
  'const channels = [portal]; for (const alias of channels) alias.capabilities = []',
  'const channels = [portal]; const iterable = channels; for (const alias of iterable) alias.capabilities = []',
  'const [alias] = [portal]; alias.capabilities = []',
  'const { value: alias } = { value: portal }; alias.capabilities = []',
  'const [alias = portal] = []; alias.capabilities = []',
  'const { value: alias = portal } = {}; alias.capabilities = []',
  'const [{ value: alias = portal } = {}] = []; alias.capabilities = []',
  'let alias; [alias] = [portal]; alias.capabilities = []',
  'let alias; ({ value: alias } = { value: portal }); alias.capabilities = []',
  'for (const [alias] of [[portal]]) alias.capabilities = []',
  'const iterable = [[portal]]; for (const [alias] of iterable) alias.capabilities = []',
  'const container = [{ value: portal }]; const iterable = container; for (const { value: alias } of iterable) alias.capabilities = []',
  'let alias; for ([alias] of [[portal]]) alias.capabilities = []',
  'let alias; for ({ value: alias } of [{ value: portal }]) alias.capabilities = []',
])("rejects a mutated loop alias in a relative Channel export: %s", async mutation => {
  const source = 'import { defineAgent } from "vite-hub/agent"; import portal from "../../portal.ts"; export default defineAgent({ channels: { github: portal } })'
  const files = { "portal.ts": `import { github } from "vite-hub/agent/channels"; const options = { pullRequest: false }; const portal = github(options); ${mutation}; export default portal` }
  await expect(discover(source, files)).rejects.toThrow(/opaque Channel|cannot inspect an imported Channel/)
  const definition = await discover(source.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"), files)
  expect(definition?.workspace).toBe("review")
})

it.each([
  'const [alias] = [options]; alias.pullRequest === false',
  'const { value: alias } = { value: options }; alias.pullRequest === false',
  'const [alias = options] = []; alias.pullRequest === false',
  'const { value: alias = options } = {}; alias.pullRequest === false',
  'const iterable = [[options]]; for (const [alias] of iterable) alias.pullRequest === false',
  'const iterable = [{ value: options }]; for (const { value: alias } of iterable) alias.pullRequest === false',
  'const container = [options]; for (const alias of container) alias.pullRequest === false',
  'const container = [options]; const iterable = container; for (const alias of iterable) alias.pullRequest === false',
])("keeps read-only container aliases stateless: %s", async read => {
  const definition = await discover(`${imports} const options = { pullRequest: false }; ${read}; export default defineAgent({ channels: { github: github(options) } })`)
  expect(definition?.workspace).toBeUndefined()
})

it.each([
  ["imported property mutation", 'portal', 'export const portal = github({ pullRequest: false })'],
  ["opaque call", '{ portal }', 'export let portal = github({ pullRequest: false }); mutate(portal)'],
  ["property mutation", '{ portal }', 'export const portal = github({ pullRequest: false }); portal.capabilities = [storage]'],
  ["default export clause", 'portal', 'const portal = github({ pullRequest: false }); portal.capabilities = [storage]; export { portal as default }'],
  ["named export alias", '{ channel as portal }', 'const portal = github({ pullRequest: false }); portal.capabilities = [storage]; export { portal as channel }'],
  ["mutated alias", '{ portal }', 'export const portal = github({ pullRequest: false }); const alias = portal; mutate(alias)'],
  ["assignment in a later initializer", '{ portal }', 'export let portal = github({ pullRequest: false }), replacement = (portal = github({ pullRequest: true }))'],
  ["type-annotated alias", '{ portal }', 'export const portal = github({ pullRequest: false }); const alias: typeof portal = portal; mutate(alias)'],
])("rejects a mutated relative Channel export: %s", async (_name, binding, declaration) => {
  const source = _name === "imported property mutation"
    ? 'import { defineAgent } from "vite-hub/agent"; import portal from "../../portal.ts"; portal.capabilities = []; export default defineAgent({ channels: { github: portal } })'
    : `import { defineAgent } from "vite-hub/agent"; import ${binding} from "../../portal.ts"; export default defineAgent({ channels: { github: portal } })`
  const files = { "portal.ts": `import { github } from "vite-hub/agent/channels"; import { defineCapability } from "vite-hub/agent"; const storage = defineCapability({ workspace: {} }); ${declaration}` }
  await expect(discover(source, files)).rejects.toThrow("opaque Channel")
  const definition = await discover(source.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"), files)
  expect(definition?.workspace).toBe("review")
})

it("ignores mutations of a shadowed Channel binding", async () => {
  const files = {
    "portal.ts": 'import { github } from "vite-hub/agent/channels"; export const portal = github({ pullRequest: false }); function log(portal) { portal.capabilities = [] }',
  }
  const definition = await discover('import { defineAgent } from "vite-hub/agent"; import { portal } from "../../portal.ts"; export default defineAgent({ channels: { github: portal } })', files)
  expect(definition?.workspace).toBeUndefined()
})

it("preserves positional destructuring aliases", async () => {
  const files = {
    "portal.ts": 'import { github } from "vite-hub/agent/channels"; const plainChannel = github({ pullRequest: false }); const ownedChannel = github({ pullRequest: true }); const [plainAlias, ownedAlias] = [plainChannel, ownedChannel]; plainAlias.capabilities = []; export { ownedAlias as default }',
  }
  const definition = await discover('import { defineAgent } from "vite-hub/agent"; import portal from "../../portal.ts"; export default defineAgent({ channels: { github: portal } })', files)
  expect(definition?.workspace).toBe("review")
})

it("tracks destructuring assignment inside an initializer", async () => {
  const files = {
    "portal.ts": 'import { github } from "vite-hub/agent/channels"; const options = { pullRequest: false }; let alias; const ignored = [alias] = [options]; alias.pullRequest = true; export default github(options)',
  }
  await expect(discover('import { defineAgent } from "vite-hub/agent"; import portal from "../../portal.ts"; export default defineAgent({ channels: { github: portal } })', files)).rejects.toThrow("opaque Channel")
})

it.each([
  ["opaque spread", 'const extra = makeChannels(); export default defineAgent({ channels: { github: { pullRequest: false }, ...extra } })'],
  ["opaque computed key", 'const key = getChannelName(); export default defineAgent({ channels: { [key]: github({ pullRequest: true }) } })'],
])("rejects opaque Channel-map entries: %s", async (_name, declaration) => {
  const source = `${imports} ${declaration}`
  await expect(discover(source)).rejects.toThrow("opaque Channel")
  const definition = await discover(source.replace("defineAgent({ channels", "defineAgent({ workspace: {}, channels"))
  expect(definition?.workspace).toBe("review")
})

it.each([
  'options.pullRequest <= true',
  'options.pullRequest >= true',
  'options.pullRequest === false',
  'options.pullRequest !== false',
  'options === options',
  'options !== undefined',
  'const alias: typeof options = options; alias.pullRequest === false',
  'const alias: <T = unknown>() => { value: T } = options as unknown as <T = unknown>() => { value: T }; alias === alias',
  'const unused = { read(options) { return options.pullRequest } }',
])("does not treat read-only expressions as mutated Channel option bindings: %s", async (comparison) => {
  const source = `${imports} const options = { pullRequest: false }; ${comparison}; export default defineAgent({ channels: { custom: github(options) } })`
  const definition = await discover(source)
  expect(definition?.workspace).toBeUndefined()
})

it("rejects angle-bracket assertion mutations of Channel options", async () => {
  const source = `${imports} const options: { pullRequest: boolean } = { pullRequest: false }; (<typeof options>options).pullRequest = true; export default defineAgent({ channels: { custom: github(options) } })`
  await expect(discover(source)).rejects.toThrow("opaque Channel")
})

it("rejects aliases assigned through container properties", async () => {
  const source = `${imports} const options = { pullRequest: false }; const holder = {} as { options: typeof options }; holder.options = options; holder.options.pullRequest = true; export default defineAgent({ channels: { custom: github(options) } })`
  await expect(discover(source)).rejects.toThrow("opaque Channel")
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

it.each([
  ['../../p\\u006frtal.ts', 'export { default } from "./i\\x6ener.ts"'],
  ['../../p\\u{6f}rtal.ts', "export { default } from './i\\u006ener.ts'"],
  ["../../p\\\nortal.ts", 'export * from "./i\\u006ener.ts"'],
])("decodes escaped relative Channel specifiers: %s", async (specifier, barrel) => {
  const named = barrel.includes("export *")
  const definition = await discover(`import ${named ? "{ portal }" : "portal"} from "${specifier}"; export default defineAgent({ channels: { custom: portal } })`, {
    "portal.ts": barrel,
    "inner.ts": `${imports} ${named ? "export const portal =" : "export default"} github({ pullRequest: false })`,
  })
  expect(definition?.workspace).toBeUndefined()
})

it.each(["\\\\8", "\\\\9", "\\\\1", "\\\\07", "\\\\08", "\\\\09"])("rejects invalid escaped relative Channel specifiers: %s", async escape => {
  await expect(discover(`import portal from "../../portal${escape}.ts"; export default defineAgent({ channels: { custom: portal } })`, {
    [`portal${escape}.ts`]: `${imports} export default github({ pullRequest: true })`,
  })).rejects.toThrow(/cannot inspect an imported Channel|opaque Channel/)
})

it.each([String.raw`'review\8'`, String.raw`'review\07'`, String.raw`'review\08'`, String.raw`'review\09'`])("rejects invalid escaped relative Channel export names: %s", async exportedName => {
  const source = `import { ${exportedName} as portal } from "../../portal.ts"; export default defineAgent({ channels: { custom: portal } })`
  await expect(discover(source, {
    "portal.ts": `${imports} const channel = github({ pullRequest: true }); export { channel as ${exportedName} }`,
  })).rejects.toThrow("cannot inspect an imported Channel")
})

it.each(["channels[\"github\"]", "channels['github']"])("recognizes statically computed namespace Channel calls: %s", async helper => {
  const setup = 'import * as channels from "vite-hub/agent/channels";'
  const source = `${setup} export default defineAgent({ channels: { custom: ${helper}({ pullRequest: true }) } })`
  const definition = await discover(source)
  expect(definition?.workspace).toBe("review")
})

it.each(["channels?.github", "channels.github?.", "channels?.github?."])("recognizes optional namespace Channel calls: %s", async helper => {
  for (const enabled of [false, true]) {
    const channel = `${helper}({ pullRequest: ${enabled} })`
    const setup = 'import * as channels from "vite-hub/agent/channels";'
    const source = `${setup} export default defineAgent({ channels: { custom: ${channel} } })`
    const local = await discover(source)
    expect(local?.workspace).toBe(enabled ? "review" : undefined)
    const imported = await discover('import portal from "../../portal.ts"; export default defineAgent({ channels: { custom: portal } })', {
      "portal.ts": `${setup} export default ${channel}`,
    })
    expect(imported?.workspace).toBe(enabled ? "review" : undefined)
  }
})

it.each([
  ['{ id: "stateless", workspace: false }', false],
  ['defineCapability({ workspace: false })', false],
  ['{ id: "stateless", workspace: null }', false],
  ['defineCapability({ workspace: 0 })', false],
  ...["0.0", "-0.0", "+0.0", ".0", "0.", "0e3", "0e-3", "0x0", "0b0", "0o0", "0_0.0_0", "0n", "0x0n", "1e-999"].flatMap(zero => [
    [`{ id: "stateless", workspace: ${zero} }`, false],
    [`{ id: "stateless", workspace: false || ${zero} }`, false],
    [`{ id: "storage", workspace: ${zero} || {} }`, true],
  ] as const),
  ...["0.1", "1e3", "0x1", "0b1", "0o1", "1n"].map(number => [`{ id: "storage", workspace: ${number} }`, true] as const),
  ['{ id: "stateless", workspace: -0 }', false],
  ['{ id: "stateless", workspace: "" }', false],
  ['{ id: "stateless", workspace: `` }', false],
  ['{ id: "stateless", workspace: false && {} }', false],
  ['{ id: "stateless", workspace: false ?? {} }', false],
  ['{ id: "stateless", workspace: false || null }', false],
  ['{ id: "storage", workspace: null ?? {} }', true],
  ['{ id: "stateless", workspace: (false as boolean) }', false],
  ['{ id: "storage", workspace: (false as boolean) || {} }', true],
  ['{ id: "combined", workspace: false, capabilities: [{ id: "storage", workspace: {} }] }', true],
  ['defineCapability({ workspace: false, capabilities: [{ id: "storage", workspace: {} }] })', true],
] as const)("matches runtime ownership for falsy Capability Workspaces: %s", async (capability, ownsWorkspace) => {
  for (const settings of [`capabilities: [${capability}]`, `channels: { custom: webChat({ capabilities: [${capability}] }) }`]) {
    const local = await discover(`${imports} export default defineAgent({ ${settings} })`)
    expect(local?.workspace).toBe(ownsWorkspace ? "review" : undefined)
    const imported = await discover('import channel from "../../channel.ts"; export default defineAgent({ channels: { custom: channel } })', {
      "channel.ts": `${imports} export default webChat({ capabilities: [${capability}] })`,
    })
    expect(imported?.workspace).toBe(ownsWorkspace ? "review" : undefined)
  }
})

it.each([
  'const wrapper = { get options() { return options } }; wrapper.options.pullRequest = true',
  'const wrapper = { get options() { return options } }; wrapper.options.enable()',
  'const wrapper = { set options(value) { options.pullRequest = value } }; wrapper.options = true',
  '({ get options() { return options } }).options.pullRequest = true',
  '({ get ["options"]() { return options } }).options.pullRequest = true',
  '({ get ["opt" + "ions"]() { return options } }).options.pullRequest = true',
  'const wrapper = { get ["options"]() { return options } }; wrapper.options.pullRequest = true',
  '({ get ["other"]() { return {} }, get ["options"]() { return options } }).options.pullRequest = true',
])("rejects mutations through accessor container aliases: %s", async mutation => {
  const source = `${imports} const options = { pullRequest: false }; ${mutation}; export default github(options)`
  await expect(discover(source.replace("export default github(options)", "export default defineAgent({ channels: { custom: github(options) } })"))).rejects.toThrow(/opaque Channel/)
  await expect(discover('import portal from "../../portal.ts"; export default defineAgent({ channels: { custom: portal } })', {
    "portal.ts": source,
  })).rejects.toThrow(/opaque Channel/)
})

it.each([
  'const getOptions = () => options; getOptions().pullRequest = true',
  'function getOptions() { return options }; getOptions()["pullRequest"] = true',
  'const getOptions = () => ({ nested: options }); getOptions().nested.pullRequest = true',
  'const getOptions = () => options; getOptions().pullRequest++',
])("rejects mutations through opaque call results: %s", async mutation => {
  const source = `${imports} const options = { pullRequest: false }; ${mutation}; export default github(options)`
  await expect(discover(source.replace("export default github(options)", "export default defineAgent({ channels: { custom: github(options) } })"))).rejects.toThrow(/opaque Channel/)
  await expect(discover('import portal from "../../portal.ts"; export default defineAgent({ channels: { custom: portal } })', {
    "portal.ts": source,
  })).rejects.toThrow(/opaque Channel/)
})

it("keeps read-only opaque call results from invalidating Channel options", async () => {
  const source = `${imports} const options = { pullRequest: false }; const getOptions = () => options; const enabled = getOptions().pullRequest; export default defineAgent({ channels: { custom: github(options) } })`
  expect((await discover(source))?.workspace).toBeUndefined()
})

it("rejects writes through captured call results inside configure callbacks", async () => {
  const source = `${imports} export default defineAgent({ options: {}, configure: () => { const options = { pullRequest: false }; const getOptions = () => options; getOptions().pullRequest = true; return defineAgent({ channels: { custom: github(options) } }) } })`
  await expect(discover(source)).rejects.toThrow(/opaque Channel/)
})

it.each([
  'const alias = getOptions(); alias.pullRequest = true',
  'let alias; alias = getOptions(); alias.pullRequest = true',
  'const alias = (getOptions()); const next = alias; next.pullRequest = true',
  'const alias = getOptions(); const enable = value => { value.pullRequest = true }; enable(alias)',
])("rejects mutations through aliases of opaque call results: %s", async mutation => {
  const setup = `${imports} const options = { pullRequest: false }; const getOptions = () => options; ${mutation};`
  await expect(discover(`${setup} export default defineAgent({ channels: { custom: github(options) } })`)).rejects.toThrow(/opaque Channel/)
  await expect(discover('import portal from "../../portal.ts"; export default defineAgent({ channels: { custom: portal } })', {
    "portal.ts": `${setup} export default github(options)`,
  })).rejects.toThrow(/opaque Channel/)
})

it.each([
  'const alias = getOptions(); const enabled = alias.pullRequest',
  'const enabled = getOptions().pullRequest',
])("keeps read-only aliases of opaque call results from invalidating Channel options: %s", async read => {
  const source = `${imports} const options = { pullRequest: false }; const getOptions = () => options; ${read}; export default defineAgent({ channels: { custom: github(options) } })`
  expect((await discover(source))?.workspace).toBeUndefined()
})

it("keeps read-only destructured opaque call results from invalidating Channel options", async () => {
  const setup = `${imports} const options = { pullRequest: false }; const getOptions = () => ({ options }); const { options: alias } = getOptions(); const enabled = alias.pullRequest;`
  expect((await discover(`${setup} export default defineAgent({ channels: { custom: github(options) } })`))?.workspace).toBeUndefined()
  expect((await discover('import portal from "../../portal.ts"; export default defineAgent({ channels: { custom: portal } })', {
    "portal.ts": `${setup} export default github(options)`,
  }))?.workspace).toBeUndefined()
})

it.each([
  'getOptions().enable()',
  'getOptions()["enable"]()',
  'const alias = getOptions(); alias.enable()',
  'const method = getOptions().enable; method()',
  'const method = getOptions()["enable"]; method()',
  'const method = getOptions().enable; const alias = method; alias()',
])("rejects mutating method calls through opaque results: %s", async mutation => {
  const setup = `${imports} const options = { pullRequest: false, enable() { this.pullRequest = true } }; const getOptions = () => options; ${mutation};`
  await expect(discover(`${setup} export default defineAgent({ channels: { custom: github(options) } })`)).rejects.toThrow(/opaque Channel/)
  await expect(discover('import portal from "../../portal.ts"; export default defineAgent({ channels: { custom: portal } })', {
    "portal.ts": `${setup} export default github(options)`,
  })).rejects.toThrow(/opaque Channel/)
})

it("rejects direct eval that may mutate captured Channel options", async () => {
  const setup = `${imports} const options = { pullRequest: false }; eval("options.pullRequest = true");`
  await expect(discover(`${setup} export default defineAgent({ channels: { custom: github(options) } })`)).rejects.toThrow(/opaque Channel/)
  await expect(discover('import portal from "../../portal.ts"; export default defineAgent({ channels: { custom: portal } })', {
    "portal.ts": `${setup} export default github(options)`,
  })).rejects.toThrow(/opaque Channel/)
})

it("keeps indirect eval from invalidating lexical Channel options", async () => {
  const definition = await discover(`${imports} const options = { pullRequest: false }; (0, eval)("options.pullRequest = true"); export default defineAgent({ channels: { custom: github(options) } })`)
  expect(definition?.workspace).toBeUndefined()
})

it.each([
  '(true ? options : other).pullRequest = true',
  '++(true ? options : other).pullRequest',
  '(enabled && options || other).pullRequest = true',
  'const set = (value = options) => { value.pullRequest = true }; set()',
  'const set = (value: { pullRequest: boolean } = options) => { value.pullRequest = true }; set()',
  'function set(value = options) { value.pullRequest = true }; set()',
])("rejects captured option mutations through compound receivers and defaults: %s", async mutation => {
  const setup = `${imports} const enabled = true; const options = { pullRequest: false }; const other = { pullRequest: false }; ${mutation};`
  await expect(discover(`${setup} export default defineAgent({ channels: { custom: github(options) } })`)).rejects.toThrow(/opaque Channel/)
  await expect(discover('import portal from "../../portal.ts"; export default defineAgent({ channels: { custom: portal } })', {
    "portal.ts": `${setup} export default github(options)`,
  })).rejects.toThrow(/opaque Channel/)
})

it("keeps read-only conditional option receivers stateless", async () => {
  const definition = await discover(`${imports} const options = { pullRequest: false }; const other = {}; const enabled = (true ? options : other).pullRequest; export default defineAgent({ channels: { custom: github(options) } })`)
  expect(definition?.workspace).toBeUndefined()
})
