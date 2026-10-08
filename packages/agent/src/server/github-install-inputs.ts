import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts";

const inputNames = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock"]);
const dependencyFields = new Set(["dependencies", "devDependencies", "optionalDependencies", "resolutions", "overrides", "catalog", "catalogs", "patchedDependencies"]);

export class GitHubDependencyConflictError extends Error {}

/** Validate decoded manifests and lockfiles before a package manager can read host paths. */
export async function validateGitHubInstallInputs(target: string): Promise<string> {
  const hash = createHash("sha256");
  const root = await realpath(target);
  const inside = (path: string) => { const part = relative(root, path); return part !== ".." && !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(part); };
  async function checkPath(value: string, base: string) {
    let decoded = decodeURIComponent(value);
    if (decoded.startsWith("//") || /^[a-z]:/i.test(decoded) || decoded.includes("\\") || decoded.startsWith("~")) throw new Error("Host-local dependency paths are not allowed.");
    if (!inside(resolve(base, decoded))) throw new Error("Host-local dependency paths must stay inside the checkout.");
    // Workspace globs have no realpath; validate the existing prefix as well.
    decoded = decoded.split(/[*?{[]/, 1)[0]!;
    const path = resolve(base, decoded || ".");
    if (!inside(path)) throw new Error("Host-local dependency paths must stay inside the checkout.");
    let current = path;
    for (;;) {
      try {
        if (!inside(await realpath(current))) throw new Error("Host-local dependency symlinks must stay inside the checkout.");
        break;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        const parent = dirname(current);
        if (parent === current) throw error;
        current = parent;
      }
    }
  }
  async function inspect(value: unknown, base: string, dependency = false, field = ""): Promise<void> {
    if (hasRuntimeType(value, "string")) {
      if (/^git(?:\+file)?:/i.test(value) && !/^git:\/\//i.test(value)) throw new Error("Host-local Git dependencies are not allowed.");
      const local = value.match(/(?:^|@)(?:file|link|portal):(.+)/i);
      if (local) await checkPath(local[1]!, base);
      else if ((dependency || ["resolved", "tarball", "directory", "workspaces"].includes(field)) && /^(?:\.{1,2}[/\\]|[/\\~]|[a-z]:[/\\])/i.test(value)) await checkPath(value, base);
      else if (field === "workspaces" || field === "directory") await checkPath(value, base);
      return;
    }
    if (Array.isArray(value)) { for (const entry of value) await inspect(entry, base, dependency, field); return; }
    if (!isRuntimeRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === "importers" && isRuntimeRecord(entry)) {
        for (const [importer, contents] of Object.entries(entry)) {
          await checkPath(importer, base);
          await inspect(contents, resolve(base, importer));
        }
      } else {
        // Lockfile package keys may themselves contain file: sources.
        if (/(?:^|@)(?:file|link|portal):/i.test(key)) await inspect(key, base);
        await inspect(entry, base, dependency || dependencyFields.has(key), key === "packages" && field === "workspaces" ? "workspaces" : key);
      }
    }
  }
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", "node_modules"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        await checkPath(path, root);
        // A package-manager input must be a regular file, so it cannot change targets.
        if (inputNames.has(entry.name)) throw new Error("Dependency inputs must not be symbolic links.");
      } else if (entry.isDirectory()) await visit(path);
      else if (inputNames.has(entry.name)) {
        const source = await readFile(path, "utf8");
        if (/^<{7} /m.test(source)) throw new GitHubDependencyConflictError(`Resolve dependency conflicts in ${relative(root, path)} and call refreshDependencies before validation.`);
        hash.update(relative(root, path)).update("\0").update(source).update("\0");
        const data: unknown = entry.name.endsWith(".json") ? JSON.parse(source) : parse(source);
        await inspect(data, directory);
        if (entry.name === "pnpm-workspace.yaml" && isRuntimeRecord(data)) {
          await inspect(data.packages, directory, false, "workspaces");
          await inspect(data.patchedDependencies, directory, true);
        }
      }
    }
  }
  await visit(root);
  return hash.digest("hex");
}
