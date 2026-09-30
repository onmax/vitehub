import { createHash } from "node:crypto"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"

const gateAttempts = new Map<string, number>()

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  const mkdir = async (...args: Parameters<typeof actual.mkdir>) => {
    const path = String(args[0])
    if (path.endsWith(".gate")) gateAttempts.set(path, (gateAttempts.get(path) ?? 0) + 1)
    return await actual.mkdir(...args)
  }
  return { ...actual, default: { ...actual, mkdir }, mkdir }
})

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function storeWithFiles(count: number) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-lock-contention-"))
  roots.push(root)
  const store = createLocalWorkspaceStore(root)
  const paths = Array.from({ length: count }, (_, index) => `docs/guide/page-${index}.md`)
  for (const path of paths) await store.writeFile(path, { path, content: path })
  const gate = (path: string) => join(root, ".vitehub/locks", `${createHash("sha256").update(path).digest("hex")}.gate`)
  return { gate, paths, root, store }
}

it("shares one directory read registration across parallel reads", async () => {
  const { gate, paths, root, store } = await storeWithFiles(32)
  gateAttempts.clear()

  const files = await Promise.all(paths.map(path => store.readFile(path)))

  expect(files).toMatchObject(paths.map(path => ({ path, content: new TextEncoder().encode(path) })))
  // Each unshared read registers and later unregisters through the gate, so
  // one attempt per read or more means parallel reads still contend for it.
  expect(gateAttempts.get(gate("docs"))).toBeLessThan(paths.length)
  expect(gateAttempts.get(gate("docs/guide"))).toBeLessThan(paths.length)
  const locks = await readdir(join(root, ".vitehub/locks"))
  expect(locks.filter(name => name.endsWith(".gate"))).toEqual([])
  for (const readers of locks.filter(name => name.endsWith(".readers")))
    expect(await readdir(join(root, ".vitehub/locks", readers))).toEqual([])
}, 60_000)

it("lets a writer pass continuous shared reads in the same process", async () => {
  const { paths, store } = await storeWithFiles(16)
  let reading = true
  const readers = Array.from({ length: 8 }, async () => {
    while (reading) await Promise.all(paths.map(path => store.readFile(path)))
  })

  try {
    await new Promise(resolve => setTimeout(resolve, 50))
    const started = Date.now()
    await store.rm("docs/guide", { recursive: true })
    expect(Date.now() - started).toBeLessThan(5_000)
  }
  finally {
    reading = false
    await Promise.all(readers)
  }
  await expect(store.readFile(paths[0]!)).resolves.toBeUndefined()
}, 60_000)
