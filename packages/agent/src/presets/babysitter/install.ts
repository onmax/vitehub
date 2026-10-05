import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { hasRuntimeType, isRuntimeRecord } from "../../internal/runtime-type.ts";
import type { BabysitterInstall } from "../babysitter.ts";

const execFileAsync = promisify(execFile);
const environmentNames = /^(?:PATH|HOME|USER|LOGNAME|LANG|LC_[A-Z]+|TMPDIR|TERM|SHELL|COREPACK_[A-Z_]+|npm_config_[a-z_]+|PNPM_HOME)$/;
const exists = (path: string) => access(path).then(() => true, () => false);
const isAbortError = (error: unknown) => error instanceof Error && error.name === "AbortError";

/** What the host did before a pass. The worker reads it from `.git/vitehub-install.json`. */
export interface BabysitterInstallRecord {
  command: string;
  ok: boolean;
  /** pnpm tree cache result. `verify-failed` means a restored tree failed its offline check and got a clean install. */
  cache?: "hit" | "miss" | "restore-failed" | "verify-failed";
  exitCode?: unknown;
  output: string;
  durationMs: number;
  /** Time spent waiting for another pass that installed the same lockfile. */
  waitMs?: number;
  restoreMs?: number;
  installMs?: number;
  saveMs?: number;
}

async function detectInstallCommand(cwd: string): Promise<string[] | undefined> {
  if (await exists(join(cwd, "pnpm-lock.yaml"))) return ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"];
  if (await exists(join(cwd, "package-lock.json"))) return ["npm", "ci", "--prefer-offline", "--no-audit", "--no-fund"];
  if (await exists(join(cwd, "bun.lock")) || await exists(join(cwd, "bun.lockb"))) return ["bun", "install", "--frozen-lockfile"];
  if (!(await exists(join(cwd, "yarn.lock")))) return undefined;
  let manager = "";
  try {
    const manifest: unknown = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
    manager = isRuntimeRecord(manifest) && hasRuntimeType(manifest.packageManager, "string") ? manifest.packageManager : "";
  } catch {}
  // Yarn 1 has no --immutable; later versions deprecate --frozen-lockfile.
  return ["yarn", "install", !manager || manager.startsWith("yarn@1.") ? "--frozen-lockfile" : "--immutable"];
}

/** The installed pnpm trees depend on the lockfile, workspace, root manifest, .npmrc, patches and Node. */
export async function pnpmInstallKey(cwd: string): Promise<string> {
  const hash = createHash("sha256").update(process.version);
  for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", ".npmrc"]) {
    hash.update(`\0${file}\0`).update(await readFile(join(cwd, file)).catch(() => ""));
  }
  const patches = await readdir(join(cwd, "patches"), { recursive: true, withFileTypes: true }).catch(() => []);
  for (const file of patches.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort()) {
    hash.update(`\0${relative(cwd, file)}\0`).update(await readFile(file));
  }
  return hash.digest("hex").slice(0, 32);
}

/** node_modules trees of the workspace root and its packages, relative to `cwd`. */
async function nodeModulesTrees(cwd: string): Promise<string[]> {
  const trees: string[] = [];
  const walk = async (directory: string, depth: number) => {
    for (const entry of await readdir(join(cwd, directory), { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name === ".git") continue;
      const path = directory ? join(directory, entry.name) : entry.name;
      if (entry.name === "node_modules") trees.push(path);
      else if (depth < 4) await walk(path, depth + 1);
    }
  };
  await walk("", 0);
  return trees;
}

async function removeNodeModules(cwd: string): Promise<void> {
  for (const tree of await nodeModulesTrees(cwd)) await rm(join(cwd, tree), { force: true, recursive: true }).catch(() => {});
}

function untilSettled(running: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void running.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
  });
}

function resolveCache(install: BabysitterInstall, env: Record<string, string | undefined>) {
  const cache = isRuntimeRecord(install) ? install.cache : undefined;
  // Hardlinked trees need GNU `cp -al`; a custom command installs without the cache.
  if (cache === false || process.platform !== "linux" || (isRuntimeRecord(install) && install.command)) return undefined;
  const configured = isRuntimeRecord(cache) ? cache : {};
  return {
    directory: configured.directory ?? (env.BABYSITTER_INSTALL_CACHE || join(tmpdir(), "vitehub-install-cache")),
    entries: configured.entries ?? Math.max(1, Math.floor(Number(env.BABYSITTER_INSTALL_CACHE_ENTRIES)) || 8),
  };
}

/**
 * Installs dependencies in a pass workspace before the provider starts. The install gets a
 * scrubbed environment without host credentials. A detected pnpm install on Linux reuses the
 * node_modules trees of an earlier pass with the same install key: the host hardlinks them into
 * the workspace, as pnpm links its own store, and verifies them with a frozen offline install.
 * Passes that need the same key wait for the first install, then restore its trees.
 */
export function createBabysitterInstaller(install: BabysitterInstall, env: Record<string, string | undefined> = process.env) {
  const cache = resolveCache(install, env);
  const inFlight = new Map<string, Promise<void>>();

  async function restore(key: string, cwd: string, signal: AbortSignal): Promise<boolean> {
    if (!cache) return false;
    const entry = join(cache.directory, key);
    const trees: unknown = await readFile(join(entry, "trees.json"), "utf8").then(text => JSON.parse(text), () => undefined);
    if (!Array.isArray(trees) || !trees.every(tree => hasRuntimeType(tree, "string") && !isAbsolute(tree) && !tree.split(sep).includes(".."))) return false;
    // A reused checkout keeps its own trees; copying over them would nest the cached tree inside.
    for (const tree of trees) if (await exists(join(cwd, tree))) return false;
    for (const tree of trees) {
      await mkdir(dirname(join(cwd, tree)), { recursive: true });
      await execFileAsync("cp", ["-al", join(entry, "files", tree), join(cwd, tree)], { signal });
    }
    const now = new Date();
    await utimes(entry, now, now).catch(() => {});
    return true;
  }

  async function save(key: string, cwd: string): Promise<void> {
    if (!cache) return;
    const entry = join(cache.directory, key);
    if (await exists(entry)) return;
    const staging = `${entry}.${process.pid}.${Date.now()}`;
    try {
      const trees = await nodeModulesTrees(cwd);
      if (!trees.length) return;
      for (const tree of trees) {
        await mkdir(dirname(join(staging, "files", tree)), { recursive: true });
        await execFileAsync("cp", ["-al", join(cwd, tree), join(staging, "files", tree)]);
      }
      await writeFile(join(staging, "trees.json"), JSON.stringify(trees));
      await rename(staging, entry);
    } catch {
      // Another filesystem or a concurrent save: the next pass installs without the cache.
      await rm(staging, { force: true, recursive: true }).catch(() => {});
      return;
    }
    // Keep the most recently used entries.
    const names = (await readdir(cache.directory).catch(() => [])).filter(name => /^[a-f0-9]{32}$/.test(name));
    const used = await Promise.all(names.map(async name => ({ name, at: (await stat(join(cache.directory, name)).catch(() => undefined))?.mtimeMs ?? 0 })));
    for (const old of used.sort((left, right) => right.at - left.at).slice(cache.entries)) {
      await rm(join(cache.directory, old.name), { force: true, recursive: true }).catch(() => {});
    }
  }

  return async function installDependencies(cwd: string, signal: AbortSignal, nodeOptions?: string): Promise<BabysitterInstallRecord | undefined> {
    if (install === false) return undefined;
    const custom = isRuntimeRecord(install) && install.command ? [install.command, ...install.args ?? []] : undefined;
    const command = custom ?? await detectInstallCommand(cwd);
    if (!command?.[0]) return undefined;
    const program = command[0];
    const startedAt = Date.now();
    const environment = Object.fromEntries([
      ...Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && environmentNames.test(entry[0])),
      ...nodeOptions ? [["NODE_OPTIONS", nodeOptions]] : [],
      ["CI", "1"],
    ]);
    const key = cache && program === "pnpm" ? await pnpmInstallKey(cwd).catch(() => undefined) : undefined;
    let finishFlight: (() => void) | undefined;
    const releaseFlight = () => {
      if (!finishFlight || !key) return;
      inFlight.delete(key);
      finishFlight();
      finishFlight = undefined;
    };
    let waitMs: number | undefined;
    let restoreMs: number | undefined;
    let installMs: number | undefined;
    let saveMs: number | undefined;
    let cacheState: BabysitterInstallRecord["cache"];
    let args = command.slice(1);
    let ran = args;
    let outcome: { ok: boolean; exitCode?: unknown; output: string };
    const run = async (runArgs: string[]) => {
      ran = runArgs;
      return await execFileAsync(program, runArgs, { cwd, env: environment, signal, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    };
    try {
      if (key) {
        const running = inFlight.get(key);
        if (running) {
          const waitStartedAt = Date.now();
          await untilSettled(running, signal);
          waitMs = Date.now() - waitStartedAt;
        }
        if (!inFlight.has(key)) inFlight.set(key, new Promise<void>(resolve => { finishFlight = resolve }));
        const restoreStartedAt = Date.now();
        try {
          if (await restore(key, cwd, signal)) {
            cacheState = "hit";
            args = args.map(value => value === "--prefer-offline" ? "--offline" : value);
          } else cacheState = "miss";
        } catch (error) {
          if (isAbortError(error) || signal.aborted) throw error;
          cacheState = "restore-failed";
          await removeNodeModules(cwd);
        }
        restoreMs = Date.now() - restoreStartedAt;
      }
      const installStartedAt = Date.now();
      try {
        let result;
        try {
          result = await run(args);
        } catch (error) {
          if (cacheState !== "hit" || isAbortError(error) || signal.aborted) throw error;
          // A restored tree that fails offline verification gets a clean full install.
          cacheState = "verify-failed";
          await removeNodeModules(cwd);
          result = await run(command.slice(1));
        }
        installMs = Date.now() - installStartedAt;
        outcome = { ok: true, output: String(result.stdout).slice(-2000) };
        if (key && cacheState !== "hit") {
          const saveStartedAt = Date.now();
          await save(key, cwd).catch(() => {});
          saveMs = Date.now() - saveStartedAt;
        }
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw error;
        const failure = isRuntimeRecord(error) ? error : {};
        outcome = { ok: false, exitCode: failure.code, output: `${String(failure.stdout ?? "").slice(-2000)}\n${String(failure.stderr ?? error).slice(-4000)}` };
      }
    } finally {
      // Waiting passes continue whether this install succeeded, failed or was aborted.
      releaseFlight();
    }
    return { command: [program, ...ran].join(" "), ...outcome, cache: cacheState, durationMs: Date.now() - startedAt, waitMs, restoreMs, installMs, saveMs };
  };
}
