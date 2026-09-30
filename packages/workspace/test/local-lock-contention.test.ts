import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"

const failedGateRemovals = new Map<string, number>()
const gateAttempts = new Map<string, number>()
const pausedProbes = new Map<string, { entered: () => void, resume: Promise<void> }>()
const pausedReads = new Map<string, { entered: () => void, resume: Promise<void> }>()

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  const mkdir = async (...args: Parameters<typeof actual.mkdir>) => {
    const path = String(args[0])
    if (path.endsWith(".gate")) gateAttempts.set(path, (gateAttempts.get(path) ?? 0) + 1)
    return await actual.mkdir(...args)
  }
  const lstat = async (...args: Parameters<typeof actual.lstat>) => {
    const result = await actual.lstat(...args).catch((error) => error as NodeJS.ErrnoException)
    const paused = pausedProbes.get(String(args[0]))
    if (paused) {
      pausedProbes.delete(String(args[0]))
      paused.entered()
      await paused.resume
    }
    if ("code" in result) throw result
    return result
  }
  const rm = async (...args: Parameters<typeof actual.rm>) => {
    const path = String(args[0])
    const failures = failedGateRemovals.get(path) ?? 0
    if (failures) {
      if (failures === 1) failedGateRemovals.delete(path)
      else failedGateRemovals.set(path, failures - 1)
      throw Object.assign(new Error("Admission gate removal failed"), { code: "EACCES" })
    }
    return await actual.rm(...args)
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
  return { ...actual, default: { ...actual, mkdir, readFile, lstat, rm }, mkdir, readFile, lstat, rm }
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

it("times out readers behind an open local writer and recovers after release", async () => {
  const { paths, store } = await storeWithFiles(1)
  const path = paths[0]!
  let entered!: () => void
  let resume!: () => void
  const writing = new Promise<void>((resolve) => { entered = resolve })
  const resumed = new Promise<void>((resolve) => { resume = resolve })
  const writer = store.writeFileStream!(path, {
    path,
    content: (async function* () {
      entered()
      await resumed
      yield new TextEncoder().encode("updated")
    })(),
  })
  await writing
  let watchdog!: ReturnType<typeof setTimeout>
  try {
    const started = Date.now()
    const readers = Promise.all([
      expect(store.readFile(path)).rejects.toThrow(`Timed out waiting to read Workspace path: ${path}.`),
      expect(store.stat(path)).rejects.toThrow(`Timed out waiting to read Workspace path: ${path}.`),
    ])
    await Promise.race([
      readers,
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("Readers did not respect the lock deadline")), 11_500)
      }),
    ])
    expect(Date.now() - started).toBeGreaterThanOrEqual(10_000)
  }
  finally {
    clearTimeout(watchdog)
    resume()
    await writer
  }
  await expect(store.readFile(path)).resolves.toMatchObject({ content: new TextEncoder().encode("updated") })
  await expect(store.stat(path)).resolves.toMatchObject({ path })
}, 20_000)

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

it("does not attach a reader when a writer takes the gate after its probe", async () => {
  const { gate, paths, root, store } = await storeWithFiles(2)
  let entered!: () => void
  let resume!: () => void
  const reading = new Promise<void>((resolve) => { entered = resolve })
  const resumed = new Promise<void>((resolve) => { resume = resolve })
  pausedReads.set(join(root, paths[0]!), { entered, resume: resumed })
  const first = store.readFile(paths[0]!)
  await reading

  let probed!: () => void
  let continueProbe!: () => void
  const probe = new Promise<void>((resolve) => { probed = resolve })
  const continued = new Promise<void>((resolve) => { continueProbe = resolve })
  const writerGate = gate("docs")
  pausedProbes.set(writerGate, { entered: probed, resume: continued })
  let completed = false
  const later = store.readFile(paths[1]!).then(file => { completed = true; return file })
  await probe
  await mkdir(writerGate)
  try {
    continueProbe()
    resume()
    await first
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(completed).toBe(false)
    expect(await readdir(writerGate.replace(/\.gate$/, ".readers"))).toEqual([])
    await writeFile(join(root, paths[1]!), "written after probe")
  }
  finally {
    continueProbe()
    resume()
    await first
    await rm(writerGate, { recursive: true, force: true })
    await later
  }
  expect(await later).toMatchObject({ content: new TextEncoder().encode("written after probe") })
}, 20_000)

it("rolls back shared reader admission when gate cleanup fails", async () => {
  const { gate, paths, root, store } = await storeWithFiles(2)
  let entered!: () => void
  let resume!: () => void
  const reading = new Promise<void>((resolve) => { entered = resolve })
  const resumed = new Promise<void>((resolve) => { resume = resolve })
  pausedReads.set(join(root, paths[0]!), { entered, resume: resumed })
  const first = store.readFile(paths[0]!)
  await reading
  const admissionGate = gate("docs")
  failedGateRemovals.set(admissionGate, 3)
  try {
    await expect(store.readFile(paths[1]!)).rejects.toThrow("Admission gate removal failed")
    resume()
    await first
    expect(await readdir(admissionGate.replace(/\.gate$/, ".readers"))).toEqual([])
  }
  finally {
    resume()
    await first
    await rm(admissionGate, { recursive: true, force: true })
  }
  await expect(store.readFile(paths[1]!)).resolves.toMatchObject({ path: paths[1] })
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


it("keeps the original read deadline when a writer races admission", async () => {
  const { gate, paths, store } = await storeWithFiles(1)
  const writerGate = gate("docs")
  let probed!: () => void
  let continueProbe!: () => void
  const probe = new Promise<void>((resolve) => { probed = resolve })
  const continued = new Promise<void>((resolve) => { continueProbe = resolve })
  pausedProbes.set(writerGate, { entered: probed, resume: continued })
  const started = Date.now()
  const reading = store.readFile(paths[0]!).then(() => undefined, error => error as Error)
  await probe
  // The reader has spent nearly its full budget before a second writer wins
  // the gate between the absence probe and the serialized admission attempt.
  const now = vi.spyOn(Date, "now").mockImplementation(() => Date.prototype.getTime.call(new Date()) + 9_900)
  await mkdir(writerGate)
  let watchdog!: ReturnType<typeof setTimeout>
  try {
    continueProbe()
    const error = await Promise.race([
      reading,
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("Admission restarted the read deadline")), 1_500)
      }),
    ])
    expect(error?.message).toContain("Timed out waiting to read Workspace path: docs.")
    expect(Date.now() - started).toBeGreaterThanOrEqual(10_000)
  }
  finally {
    clearTimeout(watchdog)
    continueProbe()
    await rm(writerGate, { recursive: true, force: true })
    await reading
    now.mockRestore()
  }
  await expect(store.readFile(paths[0]!)).resolves.toMatchObject({ path: paths[0] })
}, 20_000)
