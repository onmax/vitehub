import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"

const gateAttempts = new Map<string, number>()
const pausedReads = new Map<string, { entered: () => void, resume: Promise<void> }>()

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  const mkdir = async (...args: Parameters<typeof actual.mkdir>) => {
    const path = String(args[0])
    if (path.endsWith(".gate")) gateAttempts.set(path, (gateAttempts.get(path) ?? 0) + 1)
    return await actual.mkdir(...args)
  }
  const readFile = async (...args: Parameters<typeof actual.readFile>) => {
    const paused = pausedReads.get(String(args[0]))
    if (paused) {
      pausedReads.delete(String(args[0]))
      paused.entered()
      await paused.resume
    }
    return await actual.readFile(...args)
  }
  return { ...actual, default: { ...actual, mkdir, readFile }, mkdir, readFile }
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

it("lets a cross-process writer drain a shared lease before later reads", async () => {
  const { gate, paths, root, store } = await storeWithFiles(2)
  let entered!: () => void
  let resume!: () => void
  const reading = new Promise<void>((resolve) => { entered = resolve })
  const resumed = new Promise<void>((resolve) => { resume = resolve })
  pausedReads.set(join(root, paths[0]!), { entered, resume: resumed })
  const first = store.readFile(paths[0]!)
  await reading

  // An independent writer takes the filesystem gate without pendingWriters
  // in this process, then waits for the existing reader marker to drain.
  const writerGate = gate("docs")
  await mkdir(writerGate)
  let completed = false
  const later = store.readFile(paths[1]!).then(file => { completed = true; return file })
  try {
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(completed).toBe(false)
    resume()
    await first
    const readers = writerGate.replace(/\.gate$/, ".readers")
    expect(await readdir(readers)).toEqual([])
    await writeFile(join(root, paths[1]!), "updated by independent writer")
  }
  finally {
    resume()
    await first
    await rm(writerGate, { recursive: true, force: true })
    await later
  }
  expect(await later).toMatchObject({ content: new TextEncoder().encode("updated by independent writer") })
}, 20_000)

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
