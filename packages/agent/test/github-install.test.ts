import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { installGitHubPullRequestWorkspace, GitHubWorkspaceInstallError } from "../src/server/github-install.ts";

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
