import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBabysitterInstaller, pnpmInstallKey } from "../src/presets/babysitter/install.ts";
import { sweepBabysitterWorkspaces } from "../src/presets/babysitter/host.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function directory(name: string) {
  const path = await mkdtemp(join(tmpdir(), `vitehub-babysitter-${name}-`));
  roots.push(path);
  return path;
}

/** A stand-in pnpm that logs its calls, fails offline verification on demand and can be slow. */
async function fakePnpm() {
  const bin = await directory("bin");
  await writeFile(join(bin, "pnpm"), `#!/bin/sh
echo "$PWD $*" >> "${join(bin, "calls")}"
case "$*" in *--offline*) [ -f "${join(bin, "fail-offline")}" ] && exit 1; exit 0;; esac
sleep "$(cat "${join(bin, "delay")}" 2>/dev/null || echo 0)"
mkdir -p node_modules/pkg packages/a/node_modules/dep
echo installed > node_modules/pkg/index.js
echo dep > packages/a/node_modules/dep/index.js
`, { mode: 0o755 });
  const calls = async () => (await readFile(join(bin, "calls"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  return { bin, env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, GH_TOKEN: "host-secret" }, calls };
}

async function workspace(lockfile = "lockfileVersion: '9.0'\n") {
  const cwd = await directory("workspace");
  await writeFile(join(cwd, "pnpm-lock.yaml"), lockfile);
  await writeFile(join(cwd, "package.json"), "{}\n");
  return cwd;
}

const signal = () => new AbortController().signal;

describe.runIf(process.platform === "linux")("Babysitter dependency install cache", () => {
  it("installs on a miss, restores hardlinked trees on a hit and reinstalls when verification fails", async () => {
    const pnpm = await fakePnpm();
    const cache = await directory("cache");
    const install = createBabysitterInstaller({ cache: { directory: cache } }, pnpm.env);

    const first = await workspace();
    expect(await install(first, signal())).toMatchObject({ ok: true, cache: "miss", command: "pnpm install --frozen-lockfile --prefer-offline" });
    const key = await pnpmInstallKey(first);
    expect(JSON.parse(await readFile(join(cache, key, "trees.json"), "utf8"))).toEqual(expect.arrayContaining(["node_modules", join("packages", "a", "node_modules")]));

    const second = await workspace();
    const hit = await install(second, signal());
    expect(hit).toMatchObject({ ok: true, cache: "hit", command: "pnpm install --frozen-lockfile --offline" });
    expect(hit?.restoreMs).toBeGreaterThanOrEqual(0);
    expect(hit?.saveMs).toBeUndefined();
    const restored = await stat(join(second, "packages", "a", "node_modules", "dep", "index.js"));
    expect(restored.ino).toBe((await stat(join(first, "packages", "a", "node_modules", "dep", "index.js"))).ino);

    await writeFile(join(pnpm.bin, "fail-offline"), "");
    const third = await workspace();
    expect(await install(third, signal())).toMatchObject({ ok: true, cache: "verify-failed", command: "pnpm install --frozen-lockfile --prefer-offline" });
    expect(await readFile(join(third, "node_modules", "pkg", "index.js"), "utf8")).toBe("installed\n");
    expect((await pnpm.calls()).filter(call => call.startsWith(third))).toHaveLength(2);
  });

  it("keys the cache by the install inputs and keeps the most recently used entries", async () => {
    const pnpm = await fakePnpm();
    const cache = await directory("cache");
    const install = createBabysitterInstaller({ cache: { directory: cache, entries: 1 } }, pnpm.env);
    const first = await workspace();
    await install(first, signal());
    const changed = await workspace("lockfileVersion: '9.0'\nimporters: {}\n");
    await mkdir(join(changed, "patches"));
    expect(await pnpmInstallKey(changed)).not.toBe(await pnpmInstallKey(first));
    expect(await install(changed, signal())).toMatchObject({ cache: "miss" });
    expect((await readdir(cache)).filter(name => /^[a-f0-9]{32}$/.test(name))).toEqual([await pnpmInstallKey(changed)]);
  });

  it("runs one install per key at a time; later passes wait and restore its trees", async () => {
    const pnpm = await fakePnpm();
    await writeFile(join(pnpm.bin, "delay"), "0.3");
    const install = createBabysitterInstaller({ cache: { directory: await directory("cache") } }, pnpm.env);
    const [left, right] = [await workspace(), await workspace()];
    const [first, second] = await Promise.all([install(left, signal()), install(right, signal())]);
    expect(first).toMatchObject({ ok: true, cache: "miss" });
    expect(second).toMatchObject({ ok: true, cache: "hit" });
    expect(second?.waitMs).toBeGreaterThan(100);
    expect((await pnpm.calls()).filter(call => !call.includes("--offline"))).toHaveLength(1);
  });

  it("releases waiting passes when the first install is aborted", async () => {
    const pnpm = await fakePnpm();
    await writeFile(join(pnpm.bin, "delay"), "5");
    const install = createBabysitterInstaller({ cache: { directory: await directory("cache") } }, pnpm.env);
    const controller = new AbortController();
    const first = install(await workspace(), controller.signal);
    await new Promise(resolve => setTimeout(resolve, 100));
    const waiting = install(await workspace(), signal());
    await new Promise(resolve => setTimeout(resolve, 100));
    await writeFile(join(pnpm.bin, "delay"), "0");
    controller.abort();
    await expect(first).rejects.toThrow();
    expect(await waiting).toMatchObject({ ok: true, cache: "miss" });
  });

  it("passes only a scrubbed environment and skips the cache for a custom command or cache: false", async () => {
    const pnpm = await fakePnpm();
    const cache = await directory("cache");
    const report = join(pnpm.bin, "env.json");
    const script = `require("node:fs").writeFileSync(${JSON.stringify(report)}, JSON.stringify(process.env))`;
    const custom = createBabysitterInstaller({ command: process.execPath, args: ["-e", script], cache: { directory: cache } }, pnpm.env);
    expect(await custom(await workspace(), signal(), "--max-old-space-size=1024")).toMatchObject({ ok: true });
    const env = JSON.parse(await readFile(report, "utf8"));
    expect(env).toMatchObject({ CI: "1", NODE_OPTIONS: "--max-old-space-size=1024" });
    expect(env).not.toHaveProperty("GH_TOKEN");
    const disabled = createBabysitterInstaller({ cache: false }, pnpm.env);
    const record = await disabled(await workspace(), signal());
    expect(record).toMatchObject({ ok: true });
    expect(record?.cache).toBeUndefined();
    expect(await readdir(cache)).toEqual([]);
  });
});

describe("Babysitter workspace sweep", () => {
  it("removes stale pass workspaces only from a temporary directory inside the service directory", async () => {
    const service = await directory("service");
    const root = join(service, "tmp");
    await mkdir(root);
    const stale = ["vitehub-provider-Ab12Cd", "vitehub-provider-launch-Ab12Cd", "vitehub-baseline-Xy34Zw", "vitehub-acme-app-pr-12-Qw56Er", "t3-provider-runtime-Rt78Yu"];
    const kept = ["vitehub-provider-output-Ab12Cd", "vitehub-browser-Ab12Cd", "notes"];
    for (const name of [...stale, ...kept]) await mkdir(join(root, name));
    await writeFile(join(root, "vitehub-acme-app-pr-12-Qw56Er.meta.json"), "{}");
    const old = new Date(Date.now() - 60_000);
    for (const name of await readdir(root)) await utimes(join(root, name), old, old);
    await mkdir(join(root, "vitehub-provider-New123"));
    const startedAt = Date.now() - 1000;

    expect(await sweepBabysitterWorkspaces(root, startedAt, await directory("elsewhere"))).toBe(0);
    expect(await sweepBabysitterWorkspaces(root, startedAt, service)).toBe(stale.length + 1);
    expect((await readdir(root)).sort()).toEqual([...kept, "vitehub-provider-New123"].sort());
  });
});
