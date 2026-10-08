import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GitHubRepairCommit {
  message: string;
  paths: string[];
}

/** Git metadata is protected by provider sandboxes. Only the host stages repairs. */
export async function commitGitHubPullRequestWorkspace(
  target: string,
  input: GitHubRepairCommit,
  options: { expectedHead: string; signal?: AbortSignal; identity?: Record<string, string | undefined> },
): Promise<string> {
  options.signal?.throwIfAborted();
  if (!input.message.trim() || !input.paths.length) throw new Error("A repair message and explicit file paths are required.");
  for (const path of input.paths) {
    if (!path || path === "." || isAbsolute(path) || path.split(/[\\/]/).some(part => part === ".." || part === ".git") || path.includes("\0")) {
      throw new Error("Repair paths must name files inside the assigned checkout.");
    }
    const entry = await lstat(join(target, path)).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (entry?.isDirectory()) throw new Error("Repair paths must name individual files.");
  }
  if (!(await lstat(join(target, ".git"))).isDirectory()) throw new Error("Repair requires an independent prepared Git directory.");
  // No shell credentials, ambient Git bindings, global configuration, hooks,
  // signing programs or filesystem monitors may run during a host commit.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: options.identity?.GIT_AUTHOR_NAME ?? "ViteHub Babysitter",
    GIT_AUTHOR_EMAIL: options.identity?.GIT_AUTHOR_EMAIL ?? "babysitter@vitehub.dev",
    GIT_COMMITTER_NAME: options.identity?.GIT_COMMITTER_NAME ?? "ViteHub Babysitter",
    GIT_COMMITTER_EMAIL: options.identity?.GIT_COMMITTER_EMAIL ?? "babysitter@vitehub.dev",
  };
  const git = async (...args: string[]) => (await exec("git", ["--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", ...args], { cwd: target, env, signal: options.signal, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  if (await realpath(await git("rev-parse", "--show-toplevel")) !== await realpath(target)) throw new Error("Repair target must be its checkout root.");
  await git("merge-base", "--is-ancestor", options.expectedHead, "HEAD");
  if (await git("diff", "--cached", "--name-only")) throw new Error("Repair checkout contains unrelated staged changes.");
  await git("add", "--", ...input.paths);
  if (await git("diff", "--cached", "--name-only")) await git("commit", "-m", input.message);
  options.signal?.throwIfAborted();
  return await git("rev-parse", "HEAD");
}
