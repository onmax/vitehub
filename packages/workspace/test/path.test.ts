import { describe, expect, it } from "vitest"
import { resolve } from "node:path"

import { normalizeSafeWorkspacePath, normalizeSafeWorkspacePattern, resolveInside } from "../src/core/path.ts"

describe("Workspace path containment", () => {
  it.each(["C:/outside/file", "C:\\outside\\file", "C:outside", "a\0b"])("rejects non-portable path %j", path => {
    expect(() => normalizeSafeWorkspacePath(path)).toThrow()
    expect(() => normalizeSafeWorkspacePattern(path)).toThrow()
  })

  it("allows ordinary names containing dots and rejects parent traversal", () => {
    const root = resolve("workspace")
    for (const path of ["..notes/file", "docs../file", "docs/.../file", ""]) {
      expect(resolveInside(root, path)).toBe(resolve(root, path))
    }
    expect(() => resolveInside(root, "../outside")).toThrow()
    expect(() => resolveInside(root, "docs/../../outside")).toThrow()
  })
})

describe("reserved Workspace metadata namespace", () => {
  it.each([".vitehub", ".VITEHUB", ".ViteHub"])("rejects public paths and patterns under %s", (root) => {
    for (const path of [root, `${root}/file-metadata/foo/metadata.json`, `${root}\\file-metadata\\foo\\metadata.json`]) {
      expect(() => normalizeSafeWorkspacePath(path)).toThrow()
      expect(() => normalizeSafeWorkspacePattern(path)).toThrow()
    }
    expect(() => normalizeSafeWorkspacePattern(`${root}/**`)).toThrow()
  })

  it("preserves internal access and unrelated public paths", () => {
    expect(normalizeSafeWorkspacePath(".VITEHUB/file-metadata/foo/metadata.json", { allowReserved: true }))
      .toBe(".VITEHUB/file-metadata/foo/metadata.json")
    for (const path of [".vitehub-notes/file", "nested/.VITEHUB/file", "ordinary/file"]) {
      expect(normalizeSafeWorkspacePath(path)).toBe(path)
    }
    expect(normalizeSafeWorkspacePath("", { allowEmpty: true })).toBe("")
  })
})
