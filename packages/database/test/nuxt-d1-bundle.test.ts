import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { build } from "esbuild"
import { describe, expect, it } from "vitest"

import { hubDb } from "../src/nuxt.ts"

const packageRoot = resolve(import.meta.dirname, "..")

describe("Nuxt D1 HTTP bundles", () => {
  it.each(["netlify", "vercel", "deno-server", "node-server"])("keeps libSQL out of a %s build", async (preset) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-nuxt-d1-bundle-"))
    const hooks: Array<(config: Record<string, unknown>) => void | Promise<void>> = []
    try {
      await symlink(join(packageRoot, "node_modules"), join(root, "node_modules"), "dir")
      const definition = join(root, "server/databases/config.ts")
      await mkdir(dirname(definition), { recursive: true })
      await writeFile(definition, [
        `import { defineDatabase } from ${JSON.stringify(join(packageRoot, "src/index.ts"))}`,
        "export default defineDatabase({ cloudflare: { databaseId: 'd1-id', databaseName: 'notes', http: true }, schema: {} })",
      ].join("\n"))
      await hubDb({ driver: "d1", databaseId: "d1-id", databaseName: "notes" })(undefined, {
        hook: (event: string, callback: (config: Record<string, unknown>) => void | Promise<void>) => {
          if (event === "nitro:config") hooks.push(callback)
        },
        options: { dev: false, rootDir: root, vite: {} },
      })
      const config = { alias: {} as Record<string, string>, exportConditions: [] as string[], preset }
      for (const hook of hooks) await hook(config)
      const runtime = config.alias["@vite-hub/database/drizzle"]!
      expect(runtime).toBeTruthy()
      const bundled = await build({
        alias: { "#vitehub/database/definition-runtime": join(packageRoot, "src/runtime/definition-hosted.ts"), ...config.alias },
        bundle: true,
        conditions: config.exportConditions,
        entryPoints: [runtime],
        external: ["@vite-hub/internal/*"],
        format: "esm",
        metafile: true,
        platform: "node",
        write: false,
      })
      expect(Object.keys(bundled.metafile!.inputs).filter(file => /(?:^|\/)node_modules\/(?:@libsql\/|libsql\/|drizzle-orm\/libsql\/)/.test(file))).toEqual([])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
