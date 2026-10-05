import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { resolveInstalledProviderExecutable } from "../src/internal/provider-runtime-packages.ts"

describe("provider runtime executable resolution", () => {
  it("skips an unreadable application root", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-provider-root-"))
    const blocked = join(root, "blocked")
    await chmod(root, 0o755)
    await mkdir(blocked)
    await chmod(blocked, 0o000)
    try {
      expect(resolveInstalledProviderExecutable("codex", { resolveFrom: join(blocked, "package.json") })).toBeUndefined()
    }
    finally {
      await chmod(blocked, 0o700)
      await rm(root, { force: true, recursive: true })
    }
  })
})
