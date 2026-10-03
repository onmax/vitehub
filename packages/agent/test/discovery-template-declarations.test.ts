import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { discoverAgentDefinitions } from "../src/discovery.ts"

async function discover(expression: string) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-template-declarations-"))
  try {
    const server = join(root, "server")
    const folder = join(server, "agents", "review")
    await mkdir(folder, { recursive: true })
    await writeFile(join(server, "portal.ts"), 'import { webChat } from "vite-hub/agent/channels"; export default webChat({ capabilities: [] })')
    await writeFile(join(folder, "agent.ts"), `import { defineAgent } from "vite-hub/agent"; import portal from "../../portal.ts"; const template = \`\${${expression}}\`; export default defineAgent({ channels: { custom: portal } })`)
    return discoverAgentDefinitions({ mode: "server-agents", scanDirs: [server] })[0]
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

it.each([
  "function outer() { function portal() {}; portal.capabilities = [] }",
  "function () { function portal() {}; return portal }",
  "function () { class portal {}; return portal }",
  "function () { return portal; function portal() {} }",
  "function () { class portal { field = portal }; return portal }",
  "function () { async function portal() {}; return portal }",
  "function () { function* portal() {}; return portal }",
  "() => { function portal() {}; return portal }",
  "({ render() { class portal {}; return portal } })",
  "class { static { function portal() {}; portal } }",
  "function () { { class portal {}; portal } }",
])("keeps nested template declarations local: %s", async expression => {
  const definition = await discover(expression)
  expect(definition).toBeDefined()
  expect(definition?.workspace).toBeUndefined()
})

it.each([
  "function () { { class portal {} } return portal }",
  "function () { { function portal() {} } return portal }",
  "function () { function portal() {} }, portal",
  "function () { const local = function portal() {}; return portal }",
  "function () { const local = class portal {}; return portal }",
  "function () { class Local extends portal {} }",
])("preserves imported template reads outside declaration scopes: %s", async expression => {
  await expect(discover(expression)).rejects.toThrow(/opaque Channel/)
})
