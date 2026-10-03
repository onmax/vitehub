import { matchesAny, normalizeSafeWorkspacePath } from "./path.ts"
import type { GlobOptions } from "./types.ts"

export function createWorkspaceGlobMatcher(pattern: string | string[], options: GlobOptions = {}) {
  const requestedCwd = options.cwd === "." ? "" : options.cwd
  let cwd: string
  try {
    cwd = normalizeSafeWorkspacePath(requestedCwd, { allowEmpty: true })
  }
  catch (error) {
    // Request source descriptors are exposed under this reserved, canonical path.
    // Keep all other reserved paths rejected, including nested .git components.
    const reservedCwd = normalizeSafeWorkspacePath(requestedCwd, { allowEmpty: true, allowReserved: true })
    if (reservedCwd !== ".vitehub/sources") throw error
    cwd = reservedCwd
  }
  const prefix = cwd ? `${cwd}/` : ""
  return {
    cwd,
    matches(path: string): boolean {
      return path.startsWith(prefix) && matchesAny(path.slice(prefix.length), pattern)
    },
  }
}
