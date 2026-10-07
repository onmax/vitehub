import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveBox } from "../src/index.ts";
import { createSessionMemory } from "../src/internal/session-memory.ts";
import { createTrustedHostRuntime, type TrustedHostOptions } from "../src/internal/trusted-host.ts";

vi.mock("../src/internal/session-memory.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/internal/session-memory.ts")>(),
  createSessionMemory: vi.fn(async () => ({
    assertHealthy: async () => {},
    close: async () => {},
    kill: async () => {},
  })),
}));

describe("trusted-host resource snapshots", () => {
  it("uses the inspected budget for every session after caller mutations", async () => {
    vi.mocked(createSessionMemory).mockClear();
    const resources = { cgroupParent: "/delegated", memoryMaxBytes: 1024, memoryHighBytes: 512, memorySwapMaxBytes: 0 };
    const runtime = { kind: "trusted-host" as const, resources };
    const box = await resolveBox({ runtime }, {});
    const expected = { ...resources };
    Object.assign(resources, { cgroupParent: "/other", memoryMaxBytes: 2048, memoryHighBytes: 1536, memorySwapMaxBytes: 1024 });
    runtime.resources = { ...resources, memoryMaxBytes: 4096 };
    expect(box.plan.resources).toEqual(expected);
    expect(Object.isFrozen(box.plan.resources)).toBe(true);
    for (let index = 0; index < 2; index++) {
      const session = await box.open();
      try {
        expect(createSessionMemory).toHaveBeenLastCalledWith(expected);
      } finally {
        await session.close();
      }
    }
  });

  it("retains the state lease after failed cgroup cleanup until close succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "box-cleanup-lease-"));
    const close = vi.fn().mockRejectedValueOnce(new Error("cgroup remains populated")).mockResolvedValue(undefined);
    vi.mocked(createSessionMemory).mockResolvedValueOnce({ assertHealthy: async () => {}, close, kill: async () => {}, spawn: vi.fn() });
    const box = await resolveBox({
      home: { state: { ".state": { key: "cleanup-lease" } } },
      runtime: createTrustedHostRuntime({ stateRoot: root, resources: { cgroupParent: "/delegated", memoryMaxBytes: 1024 } }),
    }, {});
    const first = await box.open();
    try {
      await expect(first.close()).rejects.toThrow("cgroup remains populated");
      await expect(box.open({ signal: AbortSignal.timeout(100) })).rejects.toThrow();
      await first.close();
      const second = await box.open({ signal: AbortSignal.timeout(1000) });
      await second.close();
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      await first.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not add limits to a plan prepared without resources", async () => {
    vi.mocked(createSessionMemory).mockClear();
    const options: TrustedHostOptions = {};
    const box = await resolveBox({ runtime: createTrustedHostRuntime(options) }, {});
    options.resources = { cgroupParent: "/delegated", memoryMaxBytes: 1024 };
    const session = await box.open();
    try {
      expect(box.plan.resources).toBeUndefined();
      expect(createSessionMemory).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });
});
