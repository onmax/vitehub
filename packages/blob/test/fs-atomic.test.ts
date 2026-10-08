import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createDriver } from "../src/drivers/fs.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, writeFile: vi.fn(actual.writeFile) }
})

const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
const roots: string[] = []

afterEach(async () => {
  vi.mocked(writeFile).mockReset().mockImplementation(actual.writeFile)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each(["bytes", "metadata"] as const)("keeps partial %s hidden during a concurrent replacement", async (kind) => {
  const scratch = join(homedir(), ".cache/fleet/tmp")
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, "blob-atomic-"))
  roots.push(root)
  const driver = createDriver({ driver: "fs", base: root })
  await driver.put("file.txt", "old", { contentType: "text/plain" })
  let release!: () => void
  let reached!: () => void
  const paused = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { reached = resolve })
  let intercepted = false
  vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
    const selected = kind === "bytes" ? data instanceof Uint8Array : typeof data === "string"
    if (intercepted || !selected) return await actual.writeFile(path, data, options)
    intercepted = true
    if (data instanceof Uint8Array || typeof data === "string") await actual.writeFile(path, data.slice(0, 1), options)
    reached()
    await paused
    // Complete the same already-created temporary file.
    await actual.writeFile(path, data)
  })
  const publication = driver.put("file.txt", "complete", { contentType: "application/custom" })
  await started
  try {
    expect((await driver.list()).blobs.map(blob => blob.pathname)).toEqual(["file.txt"])
    if (kind === "bytes") expect(await (await driver.get("file.txt"))?.text()).toBe("old")
    else expect((await driver.head("file.txt"))?.contentType).toBe("text/plain")
  }
  finally {
    release()
    await publication
  }
  expect(await (await driver.get("file.txt"))?.text()).toBe("complete")
  expect((await driver.head("file.txt"))?.contentType).toBe("application/custom")
})
