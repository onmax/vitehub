import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"

import { createViteHubDevToken, readViteHubDevToken, removeViteHubDevToken, viteHubDevTokenFile } from "../src/dev-token.ts"

describe("private dev tokens", () => {
  it("isolates credentials by project, namespace, and server and removes only the closed server token", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-private-token-test-"))
    const first = await createViteHubDevToken(root, "schedule")
    const secondServerId = globalThis.crypto.randomUUID()
    const second = await createViteHubDevToken(root, "schedule", secondServerId)
    const scope = { namespace: "schedule", serverId: first.serverId }
    try {
      expect(first.token).not.toBe(second.token)
      expect(second.serverId).toBe(secondServerId)
      await expect(createViteHubDevToken(root, "schedule", secondServerId)).rejects.toMatchObject({ code: "EEXIST" })
      expect(await readViteHubDevToken(root, scope)).toBe(first.token)
      expect(await readViteHubDevToken(join(root, "other"), scope)).toBeUndefined()
      expect(await readViteHubDevToken(root, { ...scope, namespace: "workspace" })).toBeUndefined()
      expect(await readViteHubDevToken(root, { ...scope, serverId: "other" })).toBeUndefined()
      const file = await viteHubDevTokenFile(root, scope)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect((await stat(dirname(file))).mode & 0o777).toBe(0o700)
      await removeViteHubDevToken(root, scope)
      expect(await readViteHubDevToken(root, scope)).toBeUndefined()
      expect(await readViteHubDevToken(root, { ...scope, serverId: second.serverId })).toBe(second.token)
      await removeViteHubDevToken(root, { ...scope, serverId: second.serverId })
      expect(await readViteHubDevToken(root, { ...scope, serverId: second.serverId })).toBeUndefined()
    }
    finally {
      await removeViteHubDevToken(root, scope)
      await removeViteHubDevToken(root, { ...scope, serverId: second.serverId })
      await rm(root, { recursive: true, force: true })
    }
  })
})
