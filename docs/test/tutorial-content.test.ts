import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

const docsRoot = resolve(import.meta.dirname, "..")

function labels(source: string) {
  return [...source.matchAll(/^```[^\n]*\[([^\]]+)\]/gm)].map(match => match[1])
}

describe("multi-file tutorial examples", () => {
  it("shows ordered Workflow steps as a nested project tree", async () => {
    const source = await readFile(resolve(docsRoot, "content/docs/workflows/get-started.md"), "utf8")
    const files = labels(source)

    expect(files).toEqual(expect.arrayContaining([
      "server/workflows/onboard-user/index.ts",
      "server/workflows/onboard-user/01.create-user.ts",
      "server/workflows/onboard-user/02.send-welcome.ts",
      "server/api/onboard.post.ts",
    ]))
    expect(source).toContain("each step can be retried or replayed independently")
    expect(source).toContain("01.create-user")
    expect(source).toContain("02.send-welcome")
  })

  it("distinguishes the Sandbox package from the app route and response", async () => {
    const source = await readFile(resolve(docsRoot, "content/docs/sandbox/get-started.md"), "utf8")
    const files = labels(source)

    expect(files).toEqual(expect.arrayContaining([
      "server/sandboxes/image-optimizer/package.json",
      "server/sandboxes/image-optimizer/index.ts",
      "server/api/image-optimizer.post.ts",
      "response/image-optimizer.json",
    ]))
    expect(source).toContain("a separate package project, not another server route")
    expect(source).toContain("This JSON is the response body, not a file")
  })
})
