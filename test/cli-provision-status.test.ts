import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createBlobVercelProvisionStep } from "../packages/blob/src/provision.ts"
import { runViteHubCli } from "../packages/cli/src/index.ts"

const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

describe("Vercel Blob provision status", () => {
  it.each([false, true])("reports a skipped project lookup as unchecked with json=%s", async (json) => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-cli-blob-status-"))
    directories.push(rootDir)
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider request"))
    const stdout = { write: vi.fn<(chunk: string | Uint8Array) => void>() }
    const stderr = { write: vi.fn<(chunk: string | Uint8Array) => void>() }
    const step = createBlobVercelProvisionStep(() => ({ driver: "vercel-blob" }))
    const args = ["provision", "status", "--provider", "vercel", ...json ? ["--json"] : []]

    const exitCode = await runViteHubCli({
      args,
      cwd: rootDir,
      env: { VERCEL_TOKEN: "secret-token" },
      loadConfig: async () => ({
        plugins: [{ vitehub: { cli: { namespaces: [], provision: [step] } } }],
        root: rootDir,
      }),
      stderr,
      stdout,
    })

    expect(exitCode).toBe(0)
    const output = stdout.write.mock.calls.map(([chunk]) => String(chunk)).join("")
    const warning = "blob: skipping Vercel Blob, missing VERCEL_TOKEN/VERCEL_PROJECT_ID."
    if (json) {
      expect(JSON.parse(output)).toEqual({
        plan: { actions: [], checked: false, pending: 0 },
        provider: "vercel",
        recorded: {},
        schemaVersion: 1,
        stateFile: ".vitehub/provision.json",
        warnings: [warning],
      })
      expect(stderr.write).not.toHaveBeenCalled()
    }
    else {
      expect(output).toBe("recorded vercel ids: none in .vitehub/provision.json\nplan: not checked\n")
      expect(stderr.write.mock.calls).toEqual([[`${warning}\n`]])
    }
    expect(output).not.toContain("secret-token")
    expect(fetch).not.toHaveBeenCalled()
    await expect(readFile(join(rootDir, ".vitehub/provision.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })
})
