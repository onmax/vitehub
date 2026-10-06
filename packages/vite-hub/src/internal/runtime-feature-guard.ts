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
  const starts: number[] = []
  for (const match of clean.matchAll(/\bvitehub\s*:\s*\{|\bvitehub\s*\(\s*\{/gu)) {
    starts.push(match.index! + match[0].lastIndexOf("{"))
  }
  return starts.some(open => {
    const end = matchingBrace(clean, open)
    return end >= 0 && hasAgentOptOutInObject(clean.slice(open + 1, end))
  })
}

function hasAgentOptOutInObject(body: string): boolean {
  for (const match of body.matchAll(/\bagent\s*:\s*(false|\{)/gu)) {
    let depth = 0
    for (const character of body.slice(0, match.index)) {
      if (character === "{") depth++
      else if (character === "}") depth--
    }
    if (depth !== 0) continue
    if (match[1] === "false") return true
    const open = match.index! + match[0].lastIndexOf("{")
    const end = matchingBrace(body, open)
    if (end >= 0 && /\bcli\s*:\s*false\b/u.test(body.slice(open, end))) return true
  }
  return false
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
