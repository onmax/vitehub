import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs/promises";
import { createBabysitterProcessHost, cleanupLegacyBabysitterCheckouts } from "../src/presets/babysitter/host.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rename: vi.fn(original.rename) };
});

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

it("removes the complete legacy checkout pool, including metadata sidecars", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vitehub-babysitter-host-"));
  roots.push(dataDir);
  const pool = join(dataDir, "checkouts");
  await mkdir(join(pool, "repo-pr-42"), { recursive: true });
  await writeFile(join(pool, "repo-pr-42.meta.json"), "{}");
  await mkdir(join(pool, "another-pr"), { recursive: true });

  await expect(cleanupLegacyBabysitterCheckouts(dataDir)).resolves.toBe(3);
  await expect(stat(pool)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(cleanupLegacyBabysitterCheckouts(dataDir)).resolves.toBe(0);
});

it("refuses to remove a replaced or symlinked checkout root", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vitehub-babysitter-host-safe-"));
  roots.push(dataDir);
  const target = await mkdtemp(join(tmpdir(), "vitehub-babysitter-target-"));
  roots.push(target);
  await symlink(target, join(dataDir, "checkouts"));

  await expect(cleanupLegacyBabysitterCheckouts(dataDir)).rejects.toThrow(/unsafe Babysitter checkout pool/);
  await expect(stat(target)).resolves.toBeDefined();
});

it("cleans only the owning process host pool before reading credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-babysitter-layout-"));
  roots.push(root);
  const dataDir = join(root, ".vitehub/agents/reviewer");
  const pool = join(dataDir, "checkouts");
  const sibling = join(root, ".vitehub/agents/checkouts");
  await mkdir(pool, { recursive: true });
  await mkdir(sibling, { recursive: true });
  await writeFile(join(pool, "pr.meta.json"), "{}");
  await writeFile(join(sibling, "state.db"), "keep");
  vi.stubEnv("GITHUB_APP_ID", "");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY_PATH", "");
  // Cleanup runs before credentials and before process state is accessed.
  await expect(createBabysitterProcessHost({
    agent: { options: { filter: { repository: { allow: ["acme/repo"] } }, concurrency: 1 } },
    dataDir,
  } as Parameters<typeof createBabysitterProcessHost>[0])).rejects.toThrow("needs a GitHub App");
  await expect(stat(pool)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(sibling, "state.db"), "utf8")).toBe("keep");
});

it("preserves a replacement swapped in before claiming the pool", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vitehub-babysitter-race-"));
  roots.push(dataDir);
  const pool = join(dataDir, "checkouts");
  await mkdir(pool);
  const { rename } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let replacement = "";
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    await rename(from, join(dataDir, "original"));
    await mkdir(pool);
    await writeFile(join(pool, "keep"), "replacement");
    replacement = String(to);
    await rename(from, to);
  });
  await expect(cleanupLegacyBabysitterCheckouts(dataDir)).rejects.toThrow("replaced Babysitter checkout pool");
  expect(await readFile(join(replacement, "keep"), "utf8")).toBe("replacement");
});

it("does not delete a new pool created after claiming the old pool", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vitehub-babysitter-replacement-"));
  roots.push(dataDir);
  const pool = join(dataDir, "checkouts");
  await mkdir(pool);
  const { rename } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    await rename(from, to);
    await mkdir(pool);
    await writeFile(join(pool, "keep"), "replacement");
  });
  await expect(cleanupLegacyBabysitterCheckouts(dataDir)).resolves.toBe(0);
  expect(await readFile(join(pool, "keep"), "utf8")).toBe("replacement");
});
