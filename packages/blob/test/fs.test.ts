import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createDriver } from "../src/drivers/fs.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("fs blob driver", () => {
  it.each([
    ["", ["docs/"]],
    ["doc", ["docs/"]],
    ["docs", ["docs/"]],
    ["docs/", ["docs/reports/"]],
    ["docs/re", ["docs/reports/"]],
  ])("returns exact folded folder keys for prefix %j", async (prefix, folders) => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    tempDirs.push(base)
    const driver = createDriver({ base, driver: "fs" })
    await driver.put("docs/reports/one.txt", "one")

    await expect(driver.list({ folded: true, prefix })).resolves.toMatchObject({
      blobs: [],
      folders,
      hasMore: false,
    })
  })

  it("rejects listings when the base points at a file", async () => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    tempDirs.push(base)

    const fileBase = join(base, "not-a-directory")
    await writeFile(fileBase, "contents")

    const driver = createDriver({ base: fileBase, driver: "fs" })

    await expect(driver.list()).rejects.toMatchObject({ code: "ENOTDIR" })
  })

  it.each([
    ["empty cursor", ""],
    ["invalid alphabet", "!!!"],
    ["non-numeric payload", Buffer.from("foo").toString("base64url")],
    ["padded numeric payload", `${Buffer.from("0").toString("base64url")}=`],
    ["noncanonical pad bits", "MB"],
    ["leading-zero numeric payload", Buffer.from("01").toString("base64url")],
  ])("rejects malformed list cursors (%s)", async (_, cursor) => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    tempDirs.push(base)
    const driver = createDriver({ base, driver: "fs" })
    await driver.put("notes/one.txt", "one")

    await expect(driver.list({ cursor })).rejects.toThrow("Invalid Blob cursor.")
    await expect(driver.list({ cursor, folded: true })).rejects.toThrow("Invalid Blob cursor.")
  })

  it.each([false, true])("rejects malformed cursors before traversing a missing base (folded: %s)", async (folded) => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    tempDirs.push(base)
    const driver = createDriver({ base: join(base, "missing"), driver: "fs" })

    await expect(driver.list({ cursor: "MB", folded })).rejects.toThrow("Invalid Blob cursor.")
    await expect(driver.list({ cursor: "", folded })).rejects.toThrow("Invalid Blob cursor.")
    await expect(driver.list({ folded })).resolves.toEqual({ blobs: [], hasMore: false })
  })

  it("returns a cursor for folded listings that stop before the end", async () => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    tempDirs.push(base)

    const driver = createDriver({ base, driver: "fs" })
    await driver.put("a/root.txt", "root")
    await driver.put("a/nested/one.txt", "one")
    await driver.put("a/nested/two.txt", "two")
    await driver.put("a/z-last.txt", "last")

    const firstPage = await driver.list({ folded: true, limit: 1, prefix: "a/" })

    expect(firstPage).toMatchObject({
      blobs: [{ pathname: "a/root.txt" }],
      folders: ["a/nested/"],
      hasMore: true,
    })
    expect(firstPage.cursor).toBeDefined()

    const secondPage = await driver.list({
      cursor: firstPage.cursor,
      folded: true,
      limit: 1,
      prefix: "a/",
    })

    expect(secondPage).toMatchObject({
      blobs: [{ pathname: "a/z-last.txt" }],
      folders: [],
      hasMore: false,
    })
  })

  it("preserves content type when reading blobs", async () => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    tempDirs.push(base)

    const driver = createDriver({ base, driver: "fs" })
    await driver.put("notes/hello.txt", "hello", { contentType: "text/plain" })

    const blob = await driver.get("notes/hello.txt")

    expect(blob?.type).toBe("text/plain")
    expect(await blob?.text()).toBe("hello")
  })

  it("rejects paths reserved for internal metadata", async () => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    tempDirs.push(base)
    const driver = createDriver({ base, driver: "fs" })

    await expect(driver.put(".vitehub/blob-meta/poison.json", "{}"))
      .rejects.toMatchObject({ code: "BLOB_R0005" })
    await expect(driver.put("nested/../.vitehub/blob-meta/poison.json", "{}"))
      .rejects.toMatchObject({ code: "BLOB_R0005" })
    await expect(driver.put(".VITEHUB/blob-meta/poison.json", "{}"))
      .rejects.toMatchObject({ code: "BLOB_R0005" })
  })
})
