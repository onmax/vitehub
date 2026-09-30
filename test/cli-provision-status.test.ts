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
  it.each([false, true])("checks existing store connections without applying with json=%s", async (json) => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-cli-blob-connection-status-"))
    directories.push(rootDir)
    let projectsMetadata: Array<{ projectId: string, environments: string[] }> = []
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(init?.method).toBe("GET")
      const body = new URL(String(input)).pathname === "/v1/storage/stores"
        ? { stores: [{ id: "store_1", name: "existing-blob", type: "blob" }] }
        : { store: { projectsMetadata } }
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
    })
    const step = createBlobVercelProvisionStep(() => ({ driver: "vercel-blob" }))
    const loadConfig = async () => ({
      plugins: [{ vitehub: { cli: { namespaces: [], provision: [step] } } }],
      root: rootDir,
    })

    for (const connection of ["absent", "other-project", "incomplete", "equivalent"]) {
      const connected = connection === "equivalent"
      projectsMetadata = connection === "absent" ? [] : [{
        projectId: connection === "other-project" ? "prj_other" : "prj_1",
        environments: connection === "incomplete" ? ["production"] : ["production", "preview", "development"],
      }]
      const stdout = { write: vi.fn<(chunk: string | Uint8Array) => void>() }
      const exitCode = await runViteHubCli({
        args: ["provision", "status", "--provider", "vercel", ...json ? ["--json"] : []],
        cwd: rootDir,
        env: { VERCEL_TOKEN: "secret-token", VERCEL_PROJECT_ID: "prj_1" },
        loadConfig,
        stdout,
      })

      expect(exitCode).toBe(0)
      const output = stdout.write.mock.calls.map(([chunk]) => String(chunk)).join("")
      if (json) {
        expect(JSON.parse(output)).toMatchObject({
          plan: {
            actions: [{ exists: true, kind: "vercel-blob-store", name: "existing-blob", pending: !connected, step: "blob:vercel-blob" }],
            checked: true,
            pending: connected ? 0 : 1,
          },
        })
      }
      else {
        expect(output).toContain(`${connected ? "exists" : "pending"}\tvercel-blob-store\texisting-blob\n`)
        expect(output).toContain(connected ? "plan: no pending actions\n" : "plan: 1 pending action.")
      }
      expect(output).not.toContain("secret-token")
    }
    expect(fetch).toHaveBeenCalledTimes(8)
    await expect(readFile(join(rootDir, ".vitehub/provision.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

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
