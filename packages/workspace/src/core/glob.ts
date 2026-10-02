import { matchesAny, normalizeSafeWorkspacePath } from "./path.ts"
import type { GlobOptions } from "./types.ts"

export function createWorkspaceGlobMatcher(pattern: string | string[], options: GlobOptions = {}) {
  const cwd = normalizeSafeWorkspacePath(options.cwd === "." ? "" : options.cwd, { allowEmpty: true })
  const prefix = cwd ? `${cwd}/` : ""
  return {
    cwd,
    matches(path: string): boolean {
      return path.startsWith(prefix) && matchesAny(path.slice(prefix.length), pattern)
    },
  }
}
