import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { commitGitHubPullRequestWorkspace } from "../src/server/github-repair.ts";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-host-repair-")); roots.push(root);
  await git(root, "init", "-b", "repair");
  await writeFile(join(root, "file.txt"), "before\n");
  await writeFile(join(root, "unrelated.txt"), "keep\n");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base");
  return { root, expectedHead: await git(root, "rev-parse", "HEAD") };
}

it("commits selected repair files on the exact ancestry without running checkout hooks", async () => {
  const { root, expectedHead } = await fixture();
  await writeFile(join(root, "file.txt"), "repair\n");
  await writeFile(join(root, "unrelated.txt"), "unrelated edit\n");
  await writeFile(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const head = await commitGitHubPullRequestWorkspace(root, { message: "repair", paths: ["file.txt"] }, { expectedHead });
  expect(await git(root, "rev-parse", `${head}^`)).toBe(expectedHead);
  expect(await git(root, "show", `${head}:file.txt`)).toBe("repair");
  expect(await git(root, "show", `${head}:unrelated.txt`)).toBe("keep");
  expect(await readFile(join(root, "unrelated.txt"), "utf8")).toBe("unrelated edit\n");
});

it.each(["../outside", "/tmp/outside", ".git/config", ".", "./", "a/../../outside"])("rejects unsafe repair path %s", async path => {
  const { root, expectedHead } = await fixture();
  await expect(commitGitHubPullRequestWorkspace(root, { message: "repair", paths: [path] }, { expectedHead })).rejects.toThrow(/paths/);
  expect(await git(root, "rev-parse", "HEAD")).toBe(expectedHead);
});

it("rejects changed ancestry and pre-existing staged changes", async () => {
  const { root, expectedHead } = await fixture();
  await writeFile(join(root, "file.txt"), "repair\n");
  await git(root, "add", "file.txt");
  await expect(commitGitHubPullRequestWorkspace(root, { message: "repair", paths: ["file.txt"] }, { expectedHead })).rejects.toThrow(/staged/);
  await git(root, "reset");
  await git(root, "checkout", "--orphan", "unrelated");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "orphan");
  await expect(commitGitHubPullRequestWorkspace(root, { message: "repair", paths: ["file.txt"] }, { expectedHead })).rejects.toThrow();
});
