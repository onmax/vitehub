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

it.each([
  ["file:/srv/outside.tgz", "# yarn lockfile v1\n"],
  ["file:%2fsrv/outside.tgz", "# yarn lockfile v1\n"],
  ["file:/srv/outside.tgz", ""],
])("rejects Yarn Classic lockfile resolved source %s with header %s before execution", async (source, header) => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@1.22.22" }));
  await writeFile(join(root, "yarn.lock"), `${header}\n"unsafe@1.0.0":\n  version "1.0.0"\n  resolved ${JSON.stringify(source)}\n`);
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local/);
  await expect(readFile(join(root, "args.txt"))).rejects.toThrow();
});

it.each(["classic", "modern"])("accepts safe %s Yarn lockfile sources", async format => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: format === "classic" ? "yarn@1.22.22" : "yarn@4.9.2" }));
  await writeFile(join(root, "yarn.lock"), format === "classic"
    ? '# yarn lockfile v1\n\n"safe@^1.0.0", "safe@~1.0.0":\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/safe/-/safe-1.0.0.tgz"\n'
    : '__metadata:\n  version: 8\n\n"safe@npm:^1.0.0":\n  version: 1.0.0\n  resolution: "safe@npm:1.0.0"\n');
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
});

it("allows unrelated external symlinks during dependency validation", async () => {
  const root = await fixture();
  await symlink(tmpdir(), join(root, "docs-link"));
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
});

it.each([
  "http://127.0.0.1/private.tgz", "https://10.0.0.1/private.tgz", "https://[::1]/private.tgz",
  "https://registry.npmjs.org.attacker.example/package.tgz", "https://registry.npmjs.org@127.0.0.1/package.tgz",
  "https://registry.npmjs.org:4443/package.tgz", "git+ssh://git@127.0.0.1/private.git",
])("rejects untrusted dependency URL %s in manifests and lockfiles before execution", async source => {
  for (const input of ["manifest", "lockfile"]) {
    const root = await fixture();
    if (input === "manifest") await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { unsafe: source } }));
    else await writeFile(join(root, "pnpm-lock.yaml"), `packages:\n  unsafe:\n    resolution:\n      tarball: ${JSON.stringify(source)}\n`);
    await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/trusted HTTPS/);
    await expect(readFile(join(root, "args.txt"))).rejects.toThrow();
  }
});

it.each(["registry.npmjs.org", "registry.yarnpkg.com", "pkg.pr.new"])("accepts dependency downloads from %s", async host => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { safe: `https://${host}/safe.tgz` } }));
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
});

it.each(["packages/*", "packages/*/*"])("rejects an external symlink matched by workspace glob %s", async pattern => {
  const root = await fixture();
  await mkdir(join(root, "packages"));
  await symlink(tmpdir(), join(root, "packages", "outside"));
  await writeFile(join(root, "pnpm-workspace.yaml"), `packages:\n  - '${pattern}'\n`);
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local/);
  await expect(readFile(join(root, "args.txt"))).rejects.toThrow();
});

it.each(["pnpm", "manifest"])("rejects escaped negated %s workspace globs before execution", async manager => {
  const root = await fixture();
  const packages = ["**", "!../../outside"];
  if (manager === "pnpm") await writeFile(join(root, "pnpm-workspace.yaml"), `packages: ${JSON.stringify(packages)}\n`);
  else await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.34.6", workspaces: packages }));
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/Host-local/);
  await expect(readFile(join(root, "args.txt"))).rejects.toThrow();
});

it("preserves literal exclamation marks in file dependencies and safe workspace exclusions", async () => {
  const root = await fixture();
  await mkdir(join(root, "!local"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.34.6", dependencies: { local: "file:!local" } }));
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n  - '!packages/excluded'\n");
  await expect(installGitHubPullRequestWorkspace(root)).resolves.toBeUndefined();
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
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { unsafe: "file:./outside/local" } }));
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
  await writeFile(join(root, "pnpm-workspace.yaml"), 'packages: ["packages/*"]\n');
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

it.each(["manifest", "lockfile"])("rejects Yarn executable fetch protocols in the %s before host execution", async location => {
  const root = await fixture();
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.9.2", dependencies: { unsafe: location === "manifest" ? "exec:./script.js" : "1.0.0" } }));
  await writeFile(join(root, "yarn.lock"), '__metadata:\n  version: 8\n"unsafe@npm:1.0.0":\n  version: 1.0.0\n  resolution: "unsafe@exec:./script.js"\n');
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/protocol/);
  await expect(readFile(join(root, "args.txt"))).rejects.toThrow();
});
it.each([
  "git+https://github.com/acme/unsafe.git",
  "https://github.com/acme/unsafe.git",
  "https://github.com/acme/unsafe",
  "https://github.com/acme/unsafe/tarball/main",
  "acme/unsafe",
  "github:acme/unsafe",
])("rejects Yarn Git preparation source %s before host execution", async source => {
  for (const location of ["manifest", "lockfile"]) {
    const root = await fixture();
    await rm(join(root, "pnpm-lock.yaml"));
    await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.9.2", ...(location === "manifest" ? { dependencies: { unsafe: source } } : {}) }));
    await writeFile(join(root, "yarn.lock"), location === "manifest" ? "" : `__metadata:\n  version: 8\n"unsafe@npm:1.0.0":\n  version: 1.0.0\n  resolution: ${JSON.stringify(`unsafe@${source}`)}\n`);
    await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/protocol|Git dependencies/);
    await expect(readFile(join(root, "args.txt"))).rejects.toThrow();
  }
});
it("installs and fingerprints pnpm workspaces without a root manifest", async () => {
  const root = await fixture();
  await rm(join(root, "package.json"));
  await writeFile(join(root, "pnpm-workspace.yaml"), 'packages: ["packages/*"]\n');
  await mkdir(join(root, "packages/member"), { recursive: true });
  await writeFile(join(root, "packages/member/package.json"), '{}');
  await installGitHubPullRequestWorkspace(root);
  expect(await readFile(join(root, "args.txt"), "utf8")).toContain("pnpm@10.34.6");
  await assertGitHubDependenciesCurrent(root);
  await writeFile(join(root, "packages/member/package.json"), '{"dependencies":{"example":"1.0.0"}}');
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow(/refreshDependencies/);
});
it.each(["pnpm", "npm", "yarn"])("validates only selected %s workspaces and ignores independent fixtures", async manager => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: `${manager}@${manager === "pnpm" ? "10.34.6" : manager === "npm" ? "11.6.3" : "4.9.2"}`, ...(manager === "pnpm" ? {} : { workspaces: ["packages/member"] }) }));
  if (manager === "pnpm") await writeFile(join(root, "pnpm-workspace.yaml"), 'packages: ["packages/*", "!packages/fixture"]\n');
  else {
    await rm(join(root, "pnpm-lock.yaml"));
    await writeFile(join(root, manager === "npm" ? "package-lock.json" : "yarn.lock"), manager === "npm" ? "{}" : "__metadata:\n  version: 8\n");
  }
  for (const directory of ["test/fixtures", "packages/fixture", "packages/member"]) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, "package.json"), directory.endsWith("member") ? "{}" : '{"dependencies":{"unsafe":"exec:./script.js"}}');
    if (!directory.endsWith("member")) await writeFile(join(root, directory, ".npmrc"), "cache=/srv/outside");
  }
  await installGitHubPullRequestWorkspace(root);
  await writeFile(join(root, "packages/member/package.json"), '{"dependencies":{"unsafe":"exec:./script.js"}}');
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow(/protocol/);
});

it.each(["file:./local", "./local"])("validates referenced local packages from %s", async source => {
  const root = await fixture();
  await mkdir(join(root, "local"));
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { local: source } }));
  await writeFile(join(root, "local/package.json"), '{"dependencies":{"unsafe":"exec:./script.js"}}');
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toThrow(/protocol/);
  await expect(readFile(join(root, "args.txt"))).rejects.toThrow();
});
