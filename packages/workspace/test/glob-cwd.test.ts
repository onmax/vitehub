import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createWorkspace } from "../src/core/workspace.ts"
import { createWorkspaceAssets } from "../src/runtime/assets.ts"
import { custom } from "../src/sources/custom.ts"
import { fetch as fetchSource } from "../src/sources/fetch.ts"
import { markLiveWorkspaceSource } from "../src/sources/live.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { checkGlobCwd, globCwdPaths, seedGlobCwdStore } from "./glob-cwd-checks.ts"

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("Workspace glob cwd", () => {
  it("matches relative patterns in the memory Store", async () => {
    const store = createMemoryWorkspaceStore()
    await seedGlobCwdStore(store)
    await checkGlobCwd(store)
  })

  it("matches relative patterns in the local Store", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-glob-cwd-"))
    roots.push(root)
    const store = createLocalWorkspaceStore(root)
    await seedGlobCwdStore(store)
    await checkGlobCwd(store)
  })

  it("matches relative patterns in bundled assets", async () => {
    const assets = createWorkspaceAssets(Object.fromEntries(globCwdPaths.map(path => [path, { load: async () => path }])))
    await checkGlobCwd(assets)
  })

  it("matches relative patterns in materialized Sources through the public Workspace", async () => {
    const workspace = createWorkspace({
      name: "glob-cwd",
      store: { provider: "memory" },
      sources: { docs: custom({ mount: "", materialize: "lazy", files: globCwdPaths.map(path => ({ path, content: path })) }) },
    })
    await checkGlobCwd(workspace)
  })

  it("matches relative patterns in live Sources", async () => {
    const source = markLiveWorkspaceSource(custom({
      mount: "",
      materialize: "lazy",
      async getKeys() { return globCwdPaths },
      async getItem(key) { return { key, content: key } },
    }), Object.fromEntries(globCwdPaths.map(path => [path, `/local/${path}`])))
    const view = createWorkspaceSourceView({ name: "live-glob-cwd", sources: { docs: source } }, createMemoryWorkspaceStore())
    await checkGlobCwd(view)
  })

  it("excludes request descriptors outside cwd", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected provider request"))
    const store = createMemoryWorkspaceStore()
    await store.writeFile("docs/data.json", { path: "docs/data.json", content: "{}" })
    const querySchema = {
      "~standard": {
        jsonSchema: { input: () => ({ type: "object", properties: {} }) },
        validate: () => ({ value: {} }),
      },
    }
    const view = createWorkspaceSourceView({
      name: "descriptor-glob-cwd",
      sources: { status: fetchSource({ url: "https://example.invalid/status", querySchema }) },
    }, store)

    expect((await view.glob("**/*.json", { cwd: "docs" })).map(entry => entry.path)).toEqual(["docs/data.json"])
    expect((await view.glob("**/*.json")).map(entry => entry.path)).toEqual([".vitehub/sources/status.json", "docs/data.json"])
    expect(request).not.toHaveBeenCalled()
  })
})
