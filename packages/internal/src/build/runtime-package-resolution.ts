import { access, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

type RuntimePackageResolver = (name: string, resolver: Pick<NodeJS.Require, "resolve">, fromDir: string) => Promise<string | undefined>

/** Locates package metadata through exports, an entry's ancestors, or the project's dependency roots. */
export function createRuntimePackageResolver(readPackageName: (source: string, path: string) => unknown): RuntimePackageResolver {
  return async (name, resolver, fromDir) => {
    try {
      return resolver.resolve(`${name}/package.json`)
    }
    catch (error) {
      if (!isPackageResolutionMiss(error)) throw error
    }

    try {
      let current = dirname(resolver.resolve(name))
      while (current !== dirname(current)) {
        const candidate = join(current, "package.json")
        try {
          await access(candidate)
          if (readPackageName(await readFile(candidate, "utf8"), candidate) === name) return candidate
        }
        catch (error) {
          // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        current = dirname(current)
      }
    }
    catch (error) {
      if (!isPackageResolutionMiss(error)) throw error
    }

    let current = fromDir
    while (current !== dirname(current)) {
      const candidate = join(current, "node_modules", ...name.split("/"), "package.json")
      try {
        await access(candidate)
        return candidate
      }
      catch (error) {
        // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      current = dirname(current)
    }
  }
}

export function isPackageResolutionMiss(error: unknown): boolean {
  // SAFETY: Node module resolution failures expose their stable error code through ErrnoException.
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
}
