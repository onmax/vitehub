import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentBuildRevision } from "../build/revision.ts";

test("the package build revision tracks source changes with an unchanged manifest version", async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-build-revision-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src", "internal"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.0.4" }));
  const source = join(root, "src", "internal", "provider.ts");
  await writeFile(source, "export const repaired = false;");
  const original = agentBuildRevision(root);
  assert.equal(agentBuildRevision(root), original, "a restart or unchanged rebuild must not wake work again");
  await mkdir(join(root, "test"));
  await writeFile(join(root, "test", "provider.test.ts"), "// Test-only changes are not a worker release.");
  assert.equal(agentBuildRevision(root), original);
  await writeFile(source, "export const repaired = true;");
  const repaired = agentBuildRevision(root);
  assert.notEqual(repaired, original);
  assert.equal(agentBuildRevision(root), repaired);
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.0.4", dependencies: { provider: "2.0.0" } }));
  assert.notEqual(agentBuildRevision(root), repaired, "provider dependency updates must change the revision too");
});
