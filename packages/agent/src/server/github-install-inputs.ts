import { createHash } from "node:crypto";
import { glob, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { parseSyml } from "@yarnpkg/parsers";
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts";

const inputNames = new Set([".npmrc", "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock"]);
const dependencyFields = new Set(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "resolutions", "overrides", "catalog", "catalogs", "patchedDependencies"]);
const sourceFields = new Set(["resolved", "tarball", "resolution", "version", "specifier", "repo"]);
const downloadHosts = new Set(["registry.npmjs.org", "registry.yarnpkg.com", "pkg.pr.new", "github.com", "codeload.github.com"]);

function checkDownloadSource(value: string): void {
  // Yarn's nested protocols can percent-encode their underlying source URL.
  const decoded = decodeURIComponent(value);
  for (const match of decoded.matchAll(/(?:^|[@:(])([a-z][a-z\d+.-]*):/gi)) {
    if (!["npm", "workspace", "catalog", "file", "link", "portal", "https", "git+https"].includes(match[1]!.toLowerCase())) throw new Error("Unsupported dependency source protocol; downloads require a trusted HTTPS registry or code host.");
  }
  const source = decoded.match(/(?:^|[@:(])([a-z][a-z\d+.-]*:\/\/.+)/i)?.[1];
  if (source && !/^file:/i.test(source)) {
    const url = new URL(source.replace(/^git\+/i, ""));
    if (url.protocol !== "https:" || !downloadHosts.has(url.hostname) || url.port || url.username || url.password) throw new Error("Dependency downloads require a trusted HTTPS registry or code host.");
  } else if (/(?:^|@)git@/i.test(decoded)) throw new Error("Dependency downloads require a trusted HTTPS registry or code host.");
}
const booleanSettings = new Set(["auto-install-peers", "strict-peer-dependencies", "hoist", "shamefully-hoist", "link-workspace-packages", "prefer-workspace-packages", "shared-workspace-lockfile", "package-manager-strict"]);
const patternSettings = new Set(["hoist-pattern", "public-hoist-pattern"]);
const workspaceFields = new Set(["packages", "catalog", "catalogs", "catalogMode", "overrides", "packageExtensions", "patchedDependencies", "onlyBuiltDependencies", "ignoredBuiltDependencies", "neverBuiltDependencies", "allowBuilds"]);

function supportedSetting(key: string, value: unknown): boolean {
  const normalized = key.replace(/\[\]$/, "").replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
  if (booleanSettings.has(normalized)) return value === true || value === false || value === "true" || value === "false";
  if (normalized === "node-linker") return value === "isolated" || value === "hoisted" || value === "pnp";
  if (patternSettings.has(normalized)) return Array.isArray(value)
    ? value.every(item => hasRuntimeType(item, "string")) : hasRuntimeType(value, "string");
  return false;
}

function validateNpmConfig(source: string): void {
  for (const line of source.split(/\r?\n/)) {
    const setting = line.trim();
    if (!setting || /^[;#]/.test(setting)) continue;
    const separator = setting.indexOf("=");
    const key = setting.slice(0, separator).trim();
    const value = setting.slice(separator + 1).trim();
    if (separator < 1 || !supportedSetting(key, value)) throw new Error(`Unsupported project npm configuration: ${key || setting}. Host-local configuration paths and package-manager extensions are not allowed.`);
  }
}

export class GitHubDependencyConflictError extends Error {}

/** Validate decoded manifests and lockfiles before a package manager can read host paths. */
export async function validateGitHubInstallInputs(target: string): Promise<string> {
  const hash = createHash("sha256");
  const root = await realpath(target);
  const inside = (path: string) => { const part = relative(root, path); return part !== ".." && !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(part); };
  const packageRoots = new Set([root]);
  async function checkPath(value: string, base: string, workspace = false) {
    // Workspace exclusions still contribute crawler roots. File dependencies
    // use literal paths and must keep their leading exclamation marks.
    let decoded = decodeURIComponent(workspace ? value.replace(/^!+/, "") : value);
    if (decoded.startsWith("//") || /^[a-z]:/i.test(decoded) || decoded.includes("\\") || decoded.startsWith("~")) throw new Error("Host-local dependency paths are not allowed.");
    if (!inside(resolve(base, decoded))) throw new Error("Host-local dependency paths must stay inside the checkout.");
    // Check wildcard prefixes before deeper matching can pass through a symlink.
    const parts = decoded.split("/");
    for (let length = 1; length <= parts.length; length++) {
      const pattern = parts.slice(0, length).join("/");
      if (!/[*?{[]/.test(pattern)) continue;
      for await (const match of glob(pattern, { cwd: base })) {
        if (!inside(await realpath(resolve(base, match)))) throw new Error("Host-local dependency symlinks must stay inside the checkout.");
      }
    }
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
  async function selectLocalPackage(value: string, base: string) {
    await checkPath(value, base);
    const path = resolve(base, decodeURIComponent(value));
    if (await stat(path).then(info => info.isDirectory(), () => false)) packageRoots.add(await realpath(path));
  }
  async function inspect(value: unknown, base: string, dependency = false, field = ""): Promise<void> {
    if (hasRuntimeType(value, "string")) {
      if (field === "workspaces") { await checkPath(value, base, true); return; }
      if (dependency || sourceFields.has(field)) checkDownloadSource(value);
      if (/^git(?:\+file)?:/i.test(value) && !/^git:\/\//i.test(value)) throw new Error("Host-local Git dependencies are not allowed.");
      const local = value.match(/(?:^|@)(?:file|link|portal):(.+)/i);
      if (local) await selectLocalPackage(local[1]!, base);
      else if ((dependency || ["resolved", "tarball", "directory", "workspaces"].includes(field)) && /^(?:\.{1,2}[/\\]|[/\\~]|[a-z]:[/\\])/i.test(value)) await selectLocalPackage(value, base);
      else if (field === "directory") await selectLocalPackage(value, base);
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
        if (/(?:^|@)[a-z][a-z\d+.-]*:/i.test(decodeURIComponent(key))) checkDownloadSource(key);
        await inspect(entry, base, dependency || dependencyFields.has(key), key === "packages" && field === "workspaces" ? "workspaces" : key);
      }
    }
  }
  async function selectWorkspaces(patterns: unknown, directory: string): Promise<void> {
    if (!Array.isArray(patterns)) return;
    const values = patterns.filter(value => hasRuntimeType(value, "string"));
    for (const value of values) await checkPath(value, directory, true);
    const exclude = ["**/node_modules/**", "**/.git/**", ...values.filter(value => value.startsWith("!")).map(value => value.replace(/^!+/, ""))];
    for (const pattern of values.filter(value => !value.startsWith("!"))) {
      for await (const match of glob(pattern, { cwd: directory, exclude })) {
        const path = resolve(directory, match);
        if (await stat(path).then(info => info.isDirectory(), () => false)) packageRoots.add(await realpath(path));
      }
    }
  }
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", "node_modules"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        // A package-manager input must be a regular file, so it cannot change targets.
        if (inputNames.has(entry.name)) throw new Error("Dependency inputs must not be symbolic links.");
      } else if (entry.isDirectory()) continue;
      else if (inputNames.has(entry.name)) {
        const source = await readFile(path, "utf8");
        if (/^<{7} /m.test(source)) throw new GitHubDependencyConflictError(`Resolve dependency conflicts in ${relative(root, path)} and call refreshDependencies before validation.`);
        hash.update(relative(root, path)).update("\0").update(source).update("\0");
        if (entry.name === ".npmrc") { validateNpmConfig(source); continue; }
        let data: unknown;
        if (entry.name === "yarn.lock") {
          // Classic fields have no YAML separators. The native legacy grammar
          // also handles headerless Classic files; modern locks declare metadata.
          data = parseSyml(/^__metadata:/m.test(source) ? source : `# yarn lockfile v1\n${source}`);
          if (!isRuntimeRecord(data) || Object.values(data).some(value => !isRuntimeRecord(value))) throw new Error("Invalid Yarn lockfile stanza; dependency fields must be structured.");
        } else data = entry.name.endsWith(".json") ? JSON.parse(source) : parse(source);
        await inspect(data, directory);
        if (entry.name === "package.json" && isRuntimeRecord(data)) {
          await selectWorkspaces(Array.isArray(data.workspaces) ? data.workspaces : isRuntimeRecord(data.workspaces) ? data.workspaces.packages : undefined, directory);
        }
        if (entry.name === "pnpm-workspace.yaml" && isRuntimeRecord(data)) {
          for (const [key, value] of Object.entries(data)) {
            if (!workspaceFields.has(key) && !supportedSetting(key, value)) throw new Error(`Unsupported project pnpm configuration: ${key}. Host-local configuration paths and package-manager extensions are not allowed.`);
          }
          await selectWorkspaces(data.packages ?? ["**"], directory);
          await inspect(data.patchedDependencies, directory, true);
        }
      }
    }
  }
  for (const directory of packageRoots) await visit(directory);
  return hash.digest("hex");
}
