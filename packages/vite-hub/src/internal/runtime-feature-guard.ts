import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const configNames = [
  "vite.config.js", "vite.config.mjs", "vite.config.cjs", "vite.config.ts", "vite.config.mts", "vite.config.cts",
  "nuxt.config.js", "nuxt.config.mjs", "nuxt.config.cjs", "nuxt.config.ts", "nuxt.config.mts", "nuxt.config.cts",
]

/** Detects explicit Agent CLI opt-outs without evaluating the project config. */
export async function isAgentCliEnabled(rootDir: string): Promise<boolean> {
  for (const name of configNames) {
    const path = join(rootDir, name)
    if (!existsSync(path)) continue
    const source = await readFile(path, "utf8")
    if (/\bagent\s*:\s*false\b/u.test(source)) return false
    if (/\bagent\s*:\s*\{[^}]*\bcli\s*:\s*false\b[^}]*\}/us.test(source)) return false
  }
  return true
}
