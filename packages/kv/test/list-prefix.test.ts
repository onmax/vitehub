import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createCloudflareKVStorage } from "../src/runtime/cloudflare-kv.ts"
import { createHostedKVStorage } from "../src/runtime/hosted-storage.ts"
import type { RuntimeStorage } from "../src/runtime/hosted-storage.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const factories = {
  async hosted() {
    const base = await mkdtemp(join(tmpdir(), "vitehub-kv-prefix-"))
    tempDirs.push(base)
    return createHostedKVStorage({ store: { driver: "fs-lite", base } })
  },
  async cloudflare() {
    const values = new Map<string, string>()
    const binding = {
      delete: async (key: string) => { values.delete(key) },
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, value) },
      list: async ({ prefix = "" }: { prefix?: string }) => ({
        keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })),
        list_complete: true,
      }),
    }
    // SAFETY: The Cloudflare storage factory supplies the RuntimeStorage read, write, and list methods.
    return createCloudflareKVStorage({ binding }) as RuntimeStorage
  },
}

describe.each(Object.entries(factories))("%s KV list prefixes", (_name, createStorage) => {
  it.each(["users/al", "users\\al", "users::al", "/users/al"])("normalizes prefix %j like stored keys", async (prefix) => {
    const storage = await createStorage()
    await storage.setItem("users/alice", "alice")
    await storage.setItem("users/bob", "bob")

    await expect(storage.listKeys({ prefix, limit: 100 })).resolves.toEqual({ keys: ["users:alice"] })
  })

  it.each(["users/", "users\\", "users:"])("preserves the trailing boundary in prefix %j", async (prefix) => {
    const storage = await createStorage()
    await storage.setItem("users/alice", "alice")
    await storage.setItem("users-other/alice", "other")

    await expect(storage.listKeys({ prefix, limit: 100 })).resolves.toEqual({ keys: ["users:alice"] })
  })
})
