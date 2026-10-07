import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, rmdir, statfs, writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionMemory } from "../src/internal/session-memory.ts";

vi.mock("node:fs/promises", () => ({
  access: vi.fn(), mkdir: vi.fn(), readFile: vi.fn(), readdir: vi.fn(),
  rmdir: vi.fn(), statfs: vi.fn(), writeFile: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

let events: string;
let localEvents: string;
let peakError: NodeJS.ErrnoException | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  events = "oom_kill 1\n";
  localEvents = "oom 1\n";
  peakError = undefined;
  vi.mocked(statfs).mockResolvedValue({ type: 0x63677270 } as Awaited<ReturnType<typeof statfs>>);
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
  it("does not attribute host or ancestor kills to the session budget", async () => {
    localEvents = "oom 0\nmax 0\n";
    await expect((await open()).assertHealthy()).resolves.toBeUndefined();
  });
  it("attributes a local OOM even when the killed process was in a descendant", async () => {
    await expect((await open()).assertHealthy()).rejects.toThrow(/limit=1024.*peak=1024.*oom_kill=1/);
  });
  it("keeps the OOM diagnostic on kernels without memory.peak", async () => {
    peakError = Object.assign(new Error("missing"), { code: "ENOENT" });
    await expect((await open()).assertHealthy()).rejects.toThrow(/memory limit exceeded.*peak=unavailable/);
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
  it("starts the launcher with no caller environment and restores it after joining", async () => {
    const group = await open();
    group.spawn("echo hello", { env: { LD_PRELOAD: "/hook.so", ENV: "/hook.sh", PATH: "/untrusted" } });
    expect(spawn).toHaveBeenCalledWith("/bin/sh", [
      "-c", expect.stringContaining('shift; exec /usr/bin/env -i -- "$@"'),
      "vitehub-box", expect.stringMatching(/^\/delegated\/vitehub-box-/),
      "LD_PRELOAD=/hook.so", "ENV=/hook.sh", "PATH=/untrusted", "/bin/sh", "-c", "echo hello",
    ], { env: {} });
    expect(access).toHaveBeenCalled();
    expect(mkdir).toHaveBeenCalled();
  });
});
