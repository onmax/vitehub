import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createRuntimePackageResolver } from "../src/build/runtime-package-resolution.ts"

const roots: string[] = []
const resolvePackage = createRuntimePackageResolver((source) => {
  const value: unknown = JSON.parse(source)
  return value && typeof value === "object" && "name" in value ? value.name : undefined
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function project(exports?: object) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-runtime-resolution-"))
  roots.push(root)
  const packageRoot = join(root, "node_modules", "@fixture", "runtime")
  await mkdir(join(packageRoot, "lib"), { recursive: true })
  await writeFile(join(packageRoot, "lib", "index.js"), "module.exports = {}\n")
  const manifest = join(packageRoot, "package.json")
  await writeFile(manifest, JSON.stringify({ name: "@fixture/runtime", main: "./lib/index.js", exports }))
  return { manifest, packageRoot, root, resolver: createRequire(join(root, "package.json")) }
}

describe("runtime package metadata resolution", () => {
  it("resolves an exported package manifest", async () => {
    const fixture = await project()
    await expect(resolvePackage("@fixture/runtime", fixture.resolver, fixture.root)).resolves.toBe(fixture.manifest)
  })

  it("finds hidden metadata above a nested entry with a different package name", async () => {
    const fixture = await project({ ".": "./lib/index.js" })
    await writeFile(join(fixture.packageRoot, "lib", "package.json"), JSON.stringify({ name: "entry-metadata" }))
    await expect(resolvePackage("@fixture/runtime", fixture.resolver, fixture.root)).resolves.toBe(fixture.manifest)
  })

  it("finds import-only metadata from a nested application directory", async () => {
    const fixture = await project({ ".": { import: "./lib/index.js" } })
    const importer = join(fixture.root, "src", "feature", "entry.js")
    await mkdir(dirname(importer), { recursive: true })
    await expect(resolvePackage("@fixture/runtime", createRequire(importer), dirname(importer))).resolves.toBe(fixture.manifest)
  })

  it("returns undefined when no dependency root contains the package", async () => {
    const fixture = await project()
    await expect(resolvePackage("@fixture/missing", fixture.resolver, fixture.root)).resolves.toBeUndefined()
  })

  it("preserves resolver failures that are not missing-package errors", async () => {
    const failure = new Error("resolver failed")
    const resolver = { resolve() { throw failure } }
    await expect(resolvePackage("@fixture/runtime", resolver, "/unused")).rejects.toBe(failure)
  })

  it("preserves the owner's metadata validation errors", async () => {
    const fixture = await project({ ".": "./lib/index.js" })
    const failure = new Error("invalid owner metadata")
    const resolve = createRuntimePackageResolver(() => { throw failure })
    await expect(resolve("@fixture/runtime", fixture.resolver, fixture.root)).rejects.toBe(failure)
  })
})
