import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { createBuilder } from "vite"
import { describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  await new Promise<void>(done => server.close(() => done()))
  if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.")
  return address.port
}

async function fetchBuiltServer(root: string, path: string): Promise<Response> {
  const port = await freePort()
  const server = spawn(process.execPath, [join(root, ".output/server/index.mjs")], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: "ignore",
  })
  try {
    const deadline = Date.now() + 15_000
    while (true) {
      try {
        return await fetch(`http://127.0.0.1:${port}${path}`)
      }
      catch (error) {
        if (Date.now() > deadline) throw error
        await new Promise(done => setTimeout(done, 100))
      }
    }
  }
  finally {
    server.kill()
  }
}

describe("Source Collections through the Nitro Vite plugin", () => {
  it.each(["before", "after"] as const)("serves a generated Collection route when Nitro is registered %s ViteHub", async (nitroPosition) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-source-nitro-build-"))
    try {
      await mkdir(join(root, "server", "collections"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "collections", "articles.ts"), [
        `import * as v from "valibot"`,
        `import { defineCollection } from "vite-hub/source"`,
        ``,
        `export const articles = defineCollection(async () => [{ id: "a", title: "A" }], {`,
        `  cursor: article => article.id,`,
        `  cursorSchema: v.string(),`,
        `})`,
        ``,
      ].join("\n"))
      const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
      const plugins = nitroPosition === "before"
        ? [nitro() as never, vitehub({ preset: "node" })]
        : [vitehub({ preset: "node" }), nitro() as never]
      const builder = await createBuilder({ logLevel: "silent", plugins, root })
      await builder.buildApp()

      const response = await fetchBuiltServer(root, "/api/articles")

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("application/json")
      await expect(response.json()).resolves.toMatchObject({ items: [{ id: "a", title: "A" }] })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 120_000)
})
