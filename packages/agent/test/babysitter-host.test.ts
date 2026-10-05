import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupLegacyBabysitterCheckouts } from "../src/presets/babysitter/host.ts";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
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
