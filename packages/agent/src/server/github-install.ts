import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import * as v from "valibot";

const exec = promisify(execFile);
const manifest = v.object({ packageManager: v.optional(v.string()) });
const exists = async (path: string) => await access(path).then(() => true, () => false);

export class GitHubWorkspaceInstallError extends Error {
  constructor(cause: unknown) { super(`Frozen dependency installation failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }); }
}

/** Install frozen dependencies before entering the provider's network sandbox. */
export async function installGitHubPullRequestWorkspace(target: string, signal?: AbortSignal): Promise<void> {
  if (!(await exists(join(target, "package.json")))) return;
  signal?.throwIfAborted();
  const home = join(target, ".git", "vitehub-install-home");
  await mkdir(home, { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, YARN_ENABLE_SCRIPTS: "false", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
  const record = join(target, ".git", "vitehub-install.json");
  let command: string | undefined;
  let args: string[] = [];
  try {
    const { packageManager } = v.parse(manifest, JSON.parse(await readFile(join(target, "package.json"), "utf8")));
    if (await exists(join(target, "pnpm-lock.yaml"))) { command = "corepack"; args = ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"]; }
    else if (await exists(join(target, "package-lock.json"))) { command = "npm"; args = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]; }
    else if (await exists(join(target, "yarn.lock"))) { command = "corepack"; args = ["yarn", "install", packageManager?.startsWith("yarn@1.") ? "--frozen-lockfile" : "--immutable"]; }
    else throw new Error("Frozen dependency installation requires a supported lockfile.");
    await exec(command, args, { cwd: target, env, signal, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 });
    await writeFile(record, JSON.stringify({ status: "installed", command: command ? [command, ...args] : undefined, at: new Date().toISOString(), scripts: false }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await writeFile(record, JSON.stringify({ status: "failed", command: command ? [command, ...args] : undefined, at: new Date().toISOString(), reason })).catch(() => undefined);
    if (signal?.aborted) throw error;
    throw new GitHubWorkspaceInstallError(error);
  }
}
