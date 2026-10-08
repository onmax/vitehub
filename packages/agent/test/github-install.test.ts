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
  await writeFile(join(root, "bin", "corepack"), '#!/bin/sh\nprintf "%s\\n" "$@" > args.txt\nif [ -n "$GITHUB_APP_PRIVATE_KEY" ]; then exit 99; fi\nmkdir -p node_modules\n', { mode: 0o755 });
  vi.stubEnv("PATH", `${join(root, "bin")}:${process.env.PATH}`);
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "host-secret");
  return root;
}
it("installs on the host with a frozen lockfile and no host secrets or lifecycle scripts", async () => {
  const root = await fixture();
  await installGitHubPullRequestWorkspace(root);
  expect(await readFile(join(root, "args.txt"), "utf8")).toBe("pnpm\ninstall\n--frozen-lockfile\n--ignore-scripts\n");
  expect(JSON.parse(await readFile(join(root, ".git", "vitehub-install.json"), "utf8"))).toMatchObject({ status: "installed", scripts: false });
});
it("records a reproduced installation failure for durable retry", async () => {
  const root = await fixture();
  await writeFile(join(root, "bin", "corepack"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toBeInstanceOf(GitHubWorkspaceInstallError);
  expect(JSON.parse(await readFile(join(root, ".git", "vitehub-install.json"), "utf8"))).toMatchObject({ status: "failed" });
});
