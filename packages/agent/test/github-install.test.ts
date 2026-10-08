import { symlink, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { assertGitHubDependenciesCurrent, installGitHubPullRequestWorkspace, GitHubWorkspaceInstallError } from "../src/server/github-install.ts";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-host-install-")); roots.push(root);
  await mkdir(join(root, ".git")); await mkdir(join(root, "bin"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.34.6" }));
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(root, "bin", "corepack"), '#!/bin/sh\nprintf "%s\\n" "$@" > args.txt\nif [ -n "$GITHUB_APP_PRIVATE_KEY" ]; then exit 99; fi\nif [ "$COREPACK_ENV_FILE" != 0 ] || [ "$COREPACK_NPM_REGISTRY" != https://registry.npmjs.org ]; then exit 98; fi\nmkdir -p node_modules\n', { mode: 0o755 });
  vi.stubEnv("PATH", `${join(root, "bin")}:${process.env.PATH}`);
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "host-secret");
  return root;
}
it("installs on the host with a frozen lockfile and no host secrets or lifecycle scripts", async () => {
  const root = await fixture();
  await installGitHubPullRequestWorkspace(root);
  expect(await readFile(join(root, "args.txt"), "utf8")).toBe("pnpm@10.34.6\ninstall\n--frozen-lockfile\n--ignore-scripts\n--ignore-pnpmfile\n--config.manage-package-manager-versions=false\n");
  expect(JSON.parse(await readFile(join(root, ".git", "vitehub-install.json"), "utf8"))).toMatchObject({ status: "installed", scripts: false });
});
it("records a reproduced installation failure for durable retry", async () => {
  const root = await fixture();
  await writeFile(join(root, "bin", "corepack"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toBeInstanceOf(GitHubWorkspaceInstallError);
  expect(JSON.parse(await readFile(join(root, ".git", "vitehub-install.json"), "utf8"))).toMatchObject({ status: "failed" });
});

it("rejects checkout-selected package-manager executables before running Corepack", async () => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@https://example.com/untrusted.tgz" }));
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/official matching/);
  await expect(readFile(join(root, "args.txt"))).rejects.toThrow();
});
it.each(["1.22.22", "4.9.2"])("suppresses Yarn %s delegation, plugins and workspace scripts", async version => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: `yarn@${version}` }));
  await writeFile(join(root, "yarn.lock"), "");
  await writeFile(join(root, "bin", "corepack"), '#!/bin/sh\nprintf "%s\\n" "$@" > args.txt\nprintf "%s\\n" "$YARN_RC_FILENAME" "$COREPACK_ENABLE_PROJECT_SPEC" "$YARN_IGNORE_PATH" > env.txt\n', { mode: 0o755 });
  await installGitHubPullRequestWorkspace(root);
  const args = await readFile(join(root, "args.txt"), "utf8");
  if (version.startsWith("1.")) expect(args).toContain("--ignore-scripts\n--ignore-path\n--no-default-rc");
  else {
    expect(args).toContain("--immutable\n--mode=skip-build");
    const [config] = (await readFile(join(root, "env.txt"), "utf8")).split("\n");
    expect(config).toMatch(/^\.vitehub-install-[a-f\d-]+\.yml$/);
    await expect(readFile(join(root, config!))).rejects.toThrow();
  }
});

it("uses the declared npm version rather than the host npm binary", async () => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "npm@11.1.0" }));
  await writeFile(join(root, "package-lock.json"), "{}");
  await installGitHubPullRequestWorkspace(root);
  expect(await readFile(join(root, "args.txt"), "utf8")).toBe("npm@11.1.0\nci\n--ignore-scripts\n--no-audit\n--no-fund\n");
});

it("rejects legacy npm versions with repository onload scripts before execution", async () => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "npm@6.14.18" }));
  await writeFile(join(root, "package-lock.json"), "{}");
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/npm 7 or newer/);
  await expect(readFile(join(root, "args.txt"))).rejects.toThrow();
});
it("serializes host installers while cancellation does not hold up later work", async () => {
  const first = await fixture();
  const second = await fixture();
  const third = await fixture();
  const marker = join(first, "installer-active");
  const sequence = join(first, "sequence");
  await writeFile(join(third, "bin", "corepack"), `#!/bin/sh
if ! mkdir '${marker}'; then exit 88; fi
trap 'rmdir "${marker}"' EXIT
printf '%s\n' "$PWD" >> '${sequence}'
sleep 0.15
mkdir -p node_modules
`, { mode: 0o755 });
  const abort = new AbortController();
  const running = installGitHubPullRequestWorkspace(first);
  const cancelled = installGitHubPullRequestWorkspace(second, abort.signal);
  const last = installGitHubPullRequestWorkspace(third);
  abort.abort(new DOMException("Cancelled queued checkout", "AbortError"));
  await expect(cancelled).rejects.toThrow("Cancelled queued checkout");
  await expect(running).resolves.toBeUndefined();
  await expect(last).resolves.toBeUndefined();
  expect((await readFile(sequence, "utf8")).trim().split("\n")).toEqual([first, third]);
  await expect(readFile(join(second, "args.txt"))).rejects.toThrow();
});

it("releases the installer slot after a failed predecessor", async () => {
  const first = await fixture();
  const second = await fixture();
  await writeFile(join(second, "bin", "corepack"), `#!/bin/sh
if [ "$PWD" = '${first}' ]; then exit 7; fi
mkdir -p node_modules
`, { mode: 0o755 });
  const failed = installGitHubPullRequestWorkspace(first);
  const next = installGitHubPullRequestWorkspace(second);
  await expect(failed).rejects.toBeInstanceOf(GitHubWorkspaceInstallError);
  await expect(next).resolves.toBeUndefined();
});

it.each(["cache", "cafile"])("rejects project npm %s paths before execution", async setting => {
  const root = await fixture();
  await writeFile(join(root, ".npmrc"), `${setting}=/srv/outside\n`);
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local|Unsupported project/);
  await expect(readFile(join(root, "args.txt"))).rejects.toThrow();
});

it.each(["modulesDir", "storeDir", "cacheDir"])("rejects project pnpm %s paths before execution", async setting => {
  const root = await fixture();
  await writeFile(join(root, "pnpm-workspace.yaml"), `${setting}: /srv/outside\n`);
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local|Unsupported project/);
  await expect(readFile(join(root, "args.txt"))).rejects.toThrow();
});

it("fingerprints supported project npm settings for dependency refresh", async () => {
  const root = await fixture();
  await writeFile(join(root, ".npmrc"), "node-linker=isolated\nhoist=false\npublic-hoist-pattern[]=\n");
  await installGitHubPullRequestWorkspace(root);
  await writeFile(join(root, ".npmrc"), "node-linker=isolated\nhoist=true\n");
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow(/refreshDependencies/);
});

it("installs npm shrinkwrap-only projects", async () => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "npm@11.1.0" }));
  await writeFile(join(root, "npm-shrinkwrap.json"), "{}");
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
  expect(await readFile(join(root, "args.txt"), "utf8")).toContain("npm@11.1.0\nci\n");
});

it.each(["file:/srv/app", "file:../../outside.tgz", "/srv/app", "file:%2fetc"])("rejects host dependency %s before execution", async source => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { unsafe: source } }));
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local/);
  await expect(readFile(join(root, "args.txt"))).rejects.toThrow();
});
it("validates decoded lockfile-only sources and workspace manifests", async () => {
  const root = await fixture();
  await writeFile(join(root, "pnpm-lock.yaml"), 'packages:\n  unsafe:\n    resolution:\n      tarball: "file:\\u002fsrv/app.tgz"\n');
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local/);
  await expect(readFile(join(root, "args.txt"))).rejects.toThrow();
});
it("allows internal workspace links but rejects links through an external symlink", async () => {
  const root = await fixture();
  await mkdir(join(root, "packages", "local"), { recursive: true });
  await writeFile(join(root, "pnpm-lock.yaml"), "importers:\n  packages/local:\n    dependencies:\n      local:\n        version: link:../../packages/local\n");
  await installGitHubPullRequestWorkspace(root);
  await symlink(tmpdir(), join(root, "outside"));
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local/);
});
it("requires a dependency refresh after changing the installed graph", async () => {
  const root = await fixture();
  await installGitHubPullRequestWorkspace(root);
  await assertGitHubDependenciesCurrent(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.34.6", dependencies: { example: "1.0.0" } }));
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow(/refreshDependencies/);
  await installGitHubPullRequestWorkspace(root);
  await assertGitHubDependenciesCurrent(root);
});

it("rejects local sources in nested workspace manifests", async () => {
  const root = await fixture();
  await mkdir(join(root, "packages", "local"), { recursive: true });
  await writeFile(join(root, "packages", "local", "package.json"), JSON.stringify({ dependencies: { unsafe: "file:../../../outside" } }));
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local/);
  await expect(readFile(join(root, "args.txt"))).rejects.toThrow();
});
it("requires dependency conflicts to be resolved before refreshing the merged graph", async () => {
  const root = await fixture();
  await writeFile(join(root, "pnpm-lock.yaml"), "<<<<<<< HEAD\nlockfileVersion: '9.0'\n=======\nlockfileVersion: '9.0'\n>>>>>>> main\n");
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Resolve dependency conflicts/);
  await expect(readFile(join(root, "args.txt"))).rejects.toThrow();
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await installGitHubPullRequestWorkspace(root);
  await assertGitHubDependenciesCurrent(root);
});
