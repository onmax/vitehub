import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { resolveBox } from "@vite-hub/box";
import { importBoxCommit } from "../src/presets/babysitter/box-commit.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args])).stdout.trim();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "babysitter-box-commit-"));
  roots.push(root);
  const checkout = join(root, "host");
  const remote = join(root, "box");
  await git(root, "init", checkout);
  await writeFile(join(checkout, "source.txt"), "original\n");
  await git(checkout, "add", ".");
  await git(checkout, "commit", "-m", "base");
  const base = await git(checkout, "rev-parse", "HEAD");
  await git(root, "clone", checkout, remote);
  const session = await (await resolveBox({ runtime: "trusted-host", cwd: remote }, {})).open();
  return { checkout, remote, base, session, signal: new AbortController().signal };
}

it("imports a remote repair commit before the Box closes, including a second push", async () => {
  const f = await fixture();
  try {
    for (const contents of ["first repair\n", "second repair\n"]) {
      await writeFile(join(f.remote, "source.txt"), contents);
      await git(f.remote, "commit", "-am", "repair");
      const head = await git(f.remote, "rev-parse", "HEAD");
      expect(await git(f.checkout, "rev-parse", "HEAD")).not.toBe(head);
      await importBoxCommit(f.session, f.checkout, f.base, f.signal);
      expect(await git(f.checkout, "rev-parse", "HEAD")).toBe(head);
      expect(await git(f.checkout, "show", "HEAD:source.txt")).toBe(contents.trim());
      // The host worktree stays intact; publication only needs the imported objects and HEAD.
      expect(await readFile(join(f.checkout, "source.txt"), "utf8")).toBe("original\n");
    }
  } finally { await f.session.close(); }
});

it("leaves the host HEAD unchanged when bundle transfer fails", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.remote, "source.txt"), "repair\n");
    await git(f.remote, "commit", "-am", "repair");
    const read = vi.spyOn(f.session.files, "read").mockRejectedValueOnce(new Error("transfer failed"));
    await expect(importBoxCommit(f.session, f.checkout, f.base, f.signal)).rejects.toThrow("transfer failed");
    expect(read).toHaveBeenCalled();
    expect(await git(f.checkout, "rev-parse", "HEAD")).toBe(f.base);
    expect(await git(f.remote, "status", "--porcelain")).toBe("");
  } finally { await f.session.close(); }
});

it("rejects a repair that does not descend from the prepared HEAD", async () => {
  const f = await fixture();
  try {
    await git(f.remote, "checkout", "--orphan", "unrelated");
    await git(f.remote, "commit", "-m", "unrelated");
    await expect(importBoxCommit(f.session, f.checkout, f.base, f.signal)).rejects.toThrow("Cannot export");
    expect(await git(f.checkout, "rev-parse", "HEAD")).toBe(f.base);
  } finally { await f.session.close(); }
});

it.each([
  { transferFails: false, localCleanupFails: false },
  { transferFails: false, localCleanupFails: true },
  { transferFails: true, localCleanupFails: false },
  { transferFails: true, localCleanupFails: true },
])("preserves the import result when cleanup fails ($transferFails, $localCleanupFails)", async ({ transferFails, localCleanupFails }) => {
  const f = await fixture();
  try {
    await writeFile(join(f.remote, "source.txt"), "repair\n");
    await git(f.remote, "commit", "-am", "repair");
    const head = await git(f.remote, "rev-parse", "HEAD");
    const failure = new Error("transfer failed");
    if (transferFails) vi.spyOn(f.session.files, "read").mockRejectedValueOnce(failure);
    // Remove the real directory before simulating a filesystem cleanup rejection.
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    if (localCleanupFails) vi.mocked(rm).mockImplementationOnce(async (path, options) => {
      await actual.rm(path, options);
      throw new Error("local cleanup failed");
    });
    const remove = vi.spyOn(f.session.files, "remove").mockRejectedValueOnce(new Error("remote cleanup failed"));
    const result = importBoxCommit(f.session, f.checkout, f.base, f.signal);
    if (transferFails) await expect(result).rejects.toBe(failure);
    else await expect(result).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledOnce();
    expect(await git(f.checkout, "rev-parse", "HEAD")).toBe(transferFails ? f.base : head);
  } finally { await f.session.close(); }
});
