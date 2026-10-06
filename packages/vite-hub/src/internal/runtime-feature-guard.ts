import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const configExtensions = ["js", "mjs", "cjs", "ts", "mts", "cts"]

function stripCommentsAndStrings(source: string): string {
  return source.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, match =>
    match.startsWith("/") ? " ".repeat(match.length) : " ".repeat(match.length),
  )
}

function matchingBrace(source: string, open: number): number {
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++
    if (source[index] === "}" && --depth === 0) return index
  }
  return -1
}

function hasAgentOptOut(source: string): boolean {
  const clean = stripCommentsAndStrings(source)
  const vitehub = /\bvitehub\s*:\s*\{/gu.exec(clean)
  if (!vitehub) return false
  const vitehubEnd = matchingBrace(clean, clean.indexOf("{", vitehub.index))
  if (vitehubEnd < 0) return false
  const body = clean.slice(vitehub.index, vitehubEnd)
  const agent = /\bagent\s*:\s*(false|\{)/gu.exec(body)
  if (!agent) return false
  if (agent[1] === "false") return true
  const open = body.indexOf("{", agent.index)
  const end = matchingBrace(body, open)
  if (end < 0) return false
  return /\bcli\s*:\s*false\b/u.test(body.slice(open, end))
}

/** Detects explicit Agent CLI opt-outs without evaluating the project config. */
export async function isAgentCliEnabled(rootDir: string): Promise<boolean> {
  // Nuxt owns discovery whenever both config families exist, matching loadViteHubCliConfig.
  const owner = configExtensions.some(extension => existsSync(join(rootDir, `nuxt.config.${extension}`))) ? "nuxt" : "vite"
  for (const extension of configExtensions) {
    const path = join(rootDir, `${owner}.config.${extension}`)
    if (existsSync(path)) return !(hasAgentOptOut(await readFile(path, "utf8")))
  }
  return true
}
