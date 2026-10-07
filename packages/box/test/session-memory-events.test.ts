import { spawn } from "node:child_process";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { access, mkdir, readFile, readdir, rm, rmdir, statfs, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionMemory } from "../src/internal/session-memory.ts";

vi.mock("node:fs/promises", () => ({
  access: vi.fn(), mkdir: vi.fn(), readFile: vi.fn(), readdir: vi.fn(),
  rmdir: vi.fn(), rm: vi.fn(), statfs: vi.fn(), writeFile: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  chmodSync: vi.fn(), rmSync: vi.fn(), writeFileSync: vi.fn(),
}));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn() }));

let events: string;
let localEvents: string;
let peakError: NodeJS.ErrnoException | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  events = "oom 1\noom_kill 1\n";
  localEvents = "oom 1\n";
  peakError = undefined;
  vi.mocked(statfs).mockResolvedValue({ type: 0x63677270 } as Awaited<ReturnType<typeof statfs>>);
  vi.mocked(rm).mockResolvedValue(undefined);
  vi.mocked(readFile).mockImplementation(async (path) => {
    if (String(path).endsWith("cgroup.controllers")) return "memory";
    if (String(path).endsWith("memory.events.local")) return localEvents;
    if (String(path).endsWith("memory.events")) return events;
    if (peakError) throw peakError;
    return "1024";
  });
  vi.mocked(readdir).mockResolvedValue([]);
});

const open = () => createSessionMemory({ cgroupParent: "/delegated", memoryMaxBytes: 1024 });

describe("session memory events", () => {
  it.each(["write", "chmod", "spawn"])("preserves the %s failure when environment-file removal also fails", async (stage) => {
    const group = await open();
    const originalError = new Error(`${stage} failed`);
    const fail = () => { throw originalError; };
    if (stage === "write") vi.mocked(writeFileSync).mockImplementationOnce(fail);
    else if (stage === "chmod") vi.mocked(chmodSync).mockImplementationOnce(fail);
    else vi.mocked(spawn).mockImplementationOnce(fail);
    vi.mocked(rmSync).mockImplementationOnce(() => { throw new Error("cleanup denied"); });
    try {
      expect(() => group.spawn("true", { env: { TOKEN: "secret" } })).toThrow(originalError);
      expect(rmSync).toHaveBeenCalledWith(vi.mocked(writeFileSync).mock.calls[0]![0], { force: true });
      if (stage !== "spawn") expect(spawn).not.toHaveBeenCalled();
    } finally {
      await group.close();
    }
  });
  it("does not attribute host or ancestor kills to the session budget", async () => {
    events = "oom 1\noom_kill 1\n";
    localEvents = "oom 0\n";
    await expect((await open()).assertHealthy()).resolves.toBeUndefined();
  });
  it("attributes a local OOM even when the killed process was in a descendant", async () => {
    await expect((await open()).assertHealthy()).rejects.toThrow(/limit=1024.*peak=1024.*oom_kill=1/);
  });
  it("keeps the OOM diagnostic on kernels without memory.peak", async () => {
    peakError = Object.assign(new Error("missing"), { code: "ENOENT" });
    await expect((await open()).assertHealthy()).rejects.toThrow(/memory limit exceeded.*peak=unavailable/);
  });
  it("invalidates on local allocation OOM before any kill, without attributing a later external kill", async () => {
    events = "oom 1\noom_kill 0\n";
    const group = await open();
    await expect(group.assertHealthy()).rejects.toThrow(/local allocation OOM recorded.*observed_oom_kill=0/);
    events = "oom 1\noom_kill 1\n";
    await expect(group.assertHealthy()).rejects.toThrow(/local allocation OOM recorded.*Kill count does not identify the OOM cause/);
  });
  it("detects local OOMs on memory_localevents mounts with descendant victims", async () => {
    events = "oom 1\noom_kill 0\n";
    const group = await open();
    await expect(group.assertHealthy()).rejects.toThrow(/local allocation OOM recorded/);
    await expect(group.assertHealthy()).rejects.toThrow(/local allocation OOM recorded/);
  });
  it("rejects concurrent health checks after a local allocation OOM", async () => {
    const group = await open();
    const results = await Promise.allSettled([group.assertHealthy(), group.assertHealthy()]);
    expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
  });
  it("does not swallow other peak read failures", async () => {
    peakError = Object.assign(new Error("denied"), { code: "EACCES" });
    await expect((await open()).assertHealthy()).rejects.toThrow("denied");
  });
  it("removes nested groups before their parents", async () => {
    const group = await open();
    vi.mocked(readdir).mockResolvedValueOnce([{ name: "child", isDirectory: () => true }] as unknown as Awaited<ReturnType<typeof readdir>>);
    await group.close();
    const paths = vi.mocked(rmdir).mock.calls.map(([path]) => String(path));
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(paths[1] + "/child");
    expect(writeFile).toHaveBeenCalledWith(paths[1] + "/cgroup.kill", "1");
  });
  it("bounds populated-group teardown and permits cleanup retry", async () => {
    const group = await open();
    const read = vi.mocked(readFile).getMockImplementation()!;
    let populated = true;
    vi.mocked(readFile).mockImplementation(async (path, ...args) =>
      String(path).endsWith("cgroup.events") ? `populated ${Number(populated)}\n` : read(path, ...args));
    const clock = vi.spyOn(performance, "now");
    let elapsed = 0;
    clock.mockImplementation(() => elapsed);
    vi.mocked(delay).mockImplementation(async () => { elapsed += 1000; if (elapsed > 10_000) throw new Error("unbounded polling"); });
    try {
      await expect(group.close()).rejects.toThrow(/Timed out.*cgroup.*populated/);
      expect(rmdir).not.toHaveBeenCalled();
      expect(readdir).not.toHaveBeenCalled();
      populated = false;
      await group.close();
      expect(rmdir).toHaveBeenCalledTimes(1);
      await group.close();
      expect(rmdir).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });
  it("waits for delayed descendants before removing groups", async () => {
    const group = await open();
    const read = vi.mocked(readFile).getMockImplementation()!;
    let polls = 0;
    vi.mocked(readFile).mockImplementation(async (path, ...args) =>
      String(path).endsWith("cgroup.events") ? `populated ${++polls < 50 ? 1 : 0}\n` : read(path, ...args));
    await group.close();
    expect(polls).toBe(50);
    expect(rmdir).toHaveBeenCalledTimes(1);
  });
  it("starts the launcher with no caller environment and restores it after joining", async () => {
    const group = await open();
    group.spawn("echo hello", { env: { LD_PRELOAD: "/hook.so", ENV: "/hook.sh", PATH: "/untrusted" } });
    expect(spawn).toHaveBeenCalledWith("/bin/sh", [
      "-c", expect.stringContaining('shift 4; exec "$@"'),
      "/bin/sh", expect.stringMatching(/^\/delegated\/vitehub-box-/),
      expect.stringMatching(/vitehub-box-oom-/),
      expect.stringMatching(/^\/delegated\/vitehub-box-.*\/memory\.events\.local$/),
      expect.stringMatching(/vitehub-box-env-/), "/bin/sh", "-c", "echo hello",
    ], { env: {} });
    expect(access).toHaveBeenCalled();
    expect(mkdir).toHaveBeenCalled();
  });
});
