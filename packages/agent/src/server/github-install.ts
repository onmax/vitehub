import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateGitHubInstallInputs } from "./github-install-inputs.ts";
import { createGitHubInstallSnapshot, publishGitHubInstallSnapshot } from "./github-install-snapshot.ts";
import { randomUUID } from "node:crypto";
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
  if (!(await exists(join(target, "package.json"))) && !(await exists(join(target, "pnpm-workspace.yaml")))) return;
  signal?.throwIfAborted();
  const home = join(target, ".git", "vitehub-install-home");
  await mkdir(home, { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, YARN_ENABLE_SCRIPTS: "false", YARN_IGNORE_PATH: "1", COREPACK_ENV_FILE: "0", COREPACK_NPM_REGISTRY: "https://registry.npmjs.org", COREPACK_ENABLE_PROJECT_SPEC: "0", COREPACK_DEFAULT_TO_LATEST: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
  const record = join(target, ".git", "vitehub-install.json");
  let command: string | undefined;
  let args: string[] = [];
  let yarnConfig: string | undefined;
  let snapshot: Awaited<ReturnType<typeof createGitHubInstallSnapshot>> | undefined;
  try {
    snapshot = await createGitHubInstallSnapshot(target);
    const source = snapshot.directory;
    const fingerprint = await validateGitHubInstallInputs(source);
    const { packageManager } = v.parse(manifest, await exists(join(source, "package.json")) ? JSON.parse(await readFile(join(source, "package.json"), "utf8")) : {});
    // Corepack must not execute a PR-supplied URL, devEngines override or yarnPath.
    // Select an official package-manager version and disable repository extensions.
    const version = (name: string, fallback: string) => {
      if (!packageManager) return fallback;
      const match = packageManager.match(/^(pnpm|npm|yarn)@(\d+\.\d+\.\d+)(?:\+sha(?:224|256|384|512)\.[a-f\d]+)?$/);
      if (!match || match[1] !== name) throw new Error("packageManager must select an official matching package-manager version.");
      return match[2]!;
    };
    if (await exists(join(source, "pnpm-lock.yaml"))) {
      command = "corepack";
      args = [`pnpm@${version("pnpm", "10.34.6")}`, "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", "--config.manage-package-manager-versions=false"];
    }
    else if (await exists(join(source, "package-lock.json")) || await exists(join(source, "npm-shrinkwrap.json"))) {
      const npmVersion = version("npm", "11.6.3");
      if (Number(npmVersion.split(".")[0]) < 7) throw new Error("Host installation requires npm 7 or newer; older npm can execute repository onload scripts.");
      command = "corepack";
      args = [`npm@${npmVersion}`, "ci", "--ignore-scripts", "--no-audit", "--no-fund"];
    }
    else if (await exists(join(source, "yarn.lock"))) {
      command = "corepack";
      const yarnVersion = version("yarn", "1.22.22");
      args = [`yarn@${yarnVersion}`, "install"];
      if (yarnVersion.startsWith("1.")) args.push("--frozen-lockfile", "--ignore-scripts", "--ignore-path", "--no-default-rc");
      else {
        // A fresh rc filename ignores every checkout/ancestor plugin and yarnPath.
        // skip-build also suppresses workspace scripts, unlike enableScripts alone.
        env.YARN_RC_FILENAME = `.vitehub-install-${randomUUID()}.yml`;
        yarnConfig = join(source, env.YARN_RC_FILENAME);
        await writeFile(yarnConfig, "enableScripts: false\nignorePath: true\n", { flag: "wx" });
        args.push("--immutable", "--mode=skip-build");
      }
    }
    else throw new Error("Frozen dependency installation requires a supported lockfile.");
    await exec(command, args, { cwd: source, env, signal, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 });
    const current = await validateGitHubInstallInputs(target).catch(() => undefined);
    if (current !== fingerprint) throw new Error("Dependency inputs changed during installation. Call refreshDependencies again before validation.");
    await publishGitHubInstallSnapshot(snapshot, signal);
    await writeFile(record, JSON.stringify({ status: "installed", fingerprint, command: command ? [command, ...args] : undefined, at: new Date().toISOString(), scripts: false }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await writeFile(record, JSON.stringify({ status: "failed", command: command ? [command, ...args] : undefined, at: new Date().toISOString(), reason })).catch(() => undefined);
    if (signal?.aborted) throw error;
    throw new GitHubWorkspaceInstallError(error);
  } finally {
    if (yarnConfig) await rm(yarnConfig, { force: true });
    await snapshot?.close();
  }
}

/** Require validation to use the same dependency inputs that the host installed. */
export async function assertGitHubDependenciesCurrent(target: string): Promise<void> {
  if (!(await exists(join(target, "package.json"))) && !(await exists(join(target, "pnpm-workspace.yaml")))) return;
  const fingerprint = await validateGitHubInstallInputs(target);
  const record = v.parse(v.object({ status: v.string(), fingerprint: v.optional(v.string()) }), JSON.parse(await readFile(join(target, ".git", "vitehub-install.json"), "utf8")));
  if (record.status !== "installed" || record.fingerprint !== fingerprint) throw new Error("Dependency inputs changed or installation failed. Call refreshDependencies and rerun validation before committing.");
}
