import { afterEach, describe, expect, it } from "vitest"

import { custom, defineWorkspace, useWorkspace, type WorkspaceDefinition, type WritableWorkspaceFacade } from "../src/index.ts"
import { sha256 } from "../src/core/path.ts"
import { resetWorkspaceRegistry } from "../src/core/registry.ts"
import { createWorkspace } from "../src/core/workspace.ts"
import { createWorkspaceSourceResolutionFacade } from "../src/runtime.ts"
import { sourceSnapshotMetaKey } from "../src/sources/materialization.ts"
import { sourceSyncMetaKey } from "../src/sources/sync-state.ts"
import { isInternalWorkspaceMetaKey } from "../src/storage/metadata-keys.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { registerWorkspace } from "../src/test.ts"

afterEach(() => {
  resetWorkspaceRegistry()
})

const invocation = {
  context: {
    entries: () => new Map<string, unknown>().entries(),
    get: () => undefined,
    has: () => false,
    toJSON: () => ({}),
  },
}

// One key from each internal family, and spellings that some Stores map to the same file path.
const internalKeys = [
  sourceSyncMetaKey("docs"),
  "source:docs:snapshot",
  sourceSnapshotMetaKey("support", "docs"),
  `${sourceSnapshotMetaKey("support", "docs")}:recovery`,
  "workspace:support:startup-sources",
  "workspace:startup-source-workspaces",
  "workspace:support:build-sources",
  "workspace:support:build-files",
  "workspace:support:build-directories",
  "workspace:build-directory-users",
  "workspace-file-owner:notes%2Fprivate.md",
  "workspace-file-checkpoint:notes%2Fprivate.md",
  "Source:docs:sync",
  "WORKSPACE-FILE-OWNER:notes%2Fprivate.md",
  "/source:docs:sync",
  "\\workspace:support:build-files",
]

function docsSource(stale: "keep" | "remove" = "remove") {
  return custom({
    mount: "docs",
    sync: { stale },
    async getKeys() {
      return ["guide.md"]
    },
    async getItem(key) {
      return { key, path: key, content: "# Guide\n" }
    },
  })
}

describe("internal metadata keys", () => {
  it("classifies internal and public keys", () => {
    for (const key of internalKeys) expect(isInternalWorkspaceMetaKey(key)).toBe(true)
    for (const key of ["snapshot", "app:source:docs", "my-workspace:state", "sources", "workspaces"]) {
      expect(isInternalWorkspaceMetaKey(key)).toBe(false)
    }
  })

  it("rejects internal keys in Workspace setMeta and keeps the Store unchanged", async () => {
    const store = createMemoryWorkspaceStore()
    const workspace = createWorkspace({ name: "support", store })

    for (const key of internalKeys) {
      await expect(workspace.setMeta!(key, { forged: true })).rejects.toThrow("reserved for Workspace internals")
      await expect(store.getMeta!(key)).resolves.toBeUndefined()
    }
    await workspace.setMeta!("app:state", { ok: true })
    await expect(workspace.getMeta!("app:state")).resolves.toEqual({ ok: true })
  })

  it("rejects keys that are not strings", async () => {
    const store = createMemoryWorkspaceStore()
    const workspace = createWorkspace({ name: "support", store })
    const key = sourceSyncMetaKey("docs")
    // SAFETY: These values simulate JavaScript callers that bypass the TypeScript contract.
    const forged = [
      { startsWith: () => false, toLowerCase: () => "app", toString: () => key },
      [key],
      Object(key),
    ] as unknown as string[]

    for (const value of forged) {
      await expect(workspace.setMeta!(value, { forged: true })).rejects.toThrow("must be strings")
    }
    await expect(store.getMeta!(key)).resolves.toBeUndefined()
  })

  it("rejects internal keys in the useWorkspace facade", async () => {
    const store = createMemoryWorkspaceStore()
    registerWorkspace("support", defineWorkspace({ store }))
    const writable = useWorkspace("support", { mode: "write" })

    await expect(writable.setMeta!(sourceSyncMetaKey("docs"), { forged: true })).rejects.toThrow("reserved for Workspace internals")
    await expect(store.getMeta!(sourceSyncMetaKey("docs"))).resolves.toBeUndefined()
  })

  it("does not let a caller forge sync state that removes a user file", async () => {
    const store = createMemoryWorkspaceStore()
    registerWorkspace("support", defineWorkspace({ store, sources: { docs: docsSource() } }))
    const writable = useWorkspace("support", { mode: "write" })
    await writable.sync({ sources: ["docs"] })
    // Simulates a file that a user put in the mount before Source Sync was enabled.
    await store.writeFile("docs/user.md", { path: "docs/user.md", content: "user" })

    await expect(writable.setMeta!(sourceSyncMetaKey("docs"), {
      configHash: "forged",
      mountPath: "docs",
      paths: { "docs/user.md": { digest: await sha256("user"), sourcePath: "user.md" } },
      source: "docs",
    })).rejects.toThrow("reserved for Workspace internals")
    await writable.sync({ sources: ["docs"] })

    await expect(store.readFile("docs/user.md")).resolves.toMatchObject({ content: "user" })
  })

  it("rejects internal keys in a writable Source resolution overlay and keeps Source Sync state", async () => {
    const store = createMemoryWorkspaceStore()
    registerWorkspace("support", defineWorkspace({ store }))
    const base = useWorkspace("support", { mode: "write" })
    let keys = ["guide.md", "old.md"]
    const definition: WorkspaceDefinition = {
      name: "support",
      sources: {
        docs: custom({
          mount: "docs",
          sync: { stale: "remove" },
          async getKeys() {
            return keys
          },
          async getItem(key) {
            return { key, path: key, content: `# ${key}\n` }
          },
        }),
      },
    }
    const resolve = async () => (await createWorkspaceSourceResolutionFacade(base, definition, { invocation, overlay: true })).workspace as WritableWorkspaceFacade

    const first = await resolve()
    await expect(first.setMeta!(sourceSyncMetaKey("docs"), { forged: true })).rejects.toThrow("reserved for Workspace internals")
    await expect(first.sync({ sources: ["docs"] })).resolves.toMatchObject({ status: "ready" })
    // Source Sync writes its state through the owner path.
    await expect(store.getMeta!(sourceSyncMetaKey("docs"))).resolves.toMatchObject({ source: "docs" })

    keys = ["guide.md"]
    await expect((await resolve()).sync({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [expect.objectContaining({ counts: expect.objectContaining({ removed: 1 }) })],
    })
    await expect(store.stat("docs/old.md")).resolves.toBeUndefined()
  })
})
