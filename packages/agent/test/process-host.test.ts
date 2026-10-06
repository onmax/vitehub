import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts";
import { createProcessAgentHost } from "../src/runtime/process.ts";

it("starts once and drains tracked work before closing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vitehub-process-host-"));
  let release!: () => void;
  const work = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = vi.fn((_reason, { track }, accepting) => {
    expect(accepting()).toBe(true);
    track(work);
  });
  const host = await createProcessAgentHost({ dataDir: join(dataDir, "nested"), capacity: { concurrency: 1 }, run });
  try {
    expect(host.status()).toBe("starting");
    host.start();
    host.start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    let closed = false;
    const close = host.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await close;
    expect(host.status()).toBe("drained");
    host.wake();
    host.start();
    expect(run).toHaveBeenCalledOnce();
    expect((await host.health()).workload.stale).toBe(0);
  } finally {
    release();
    await host.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

it("uses a shared journal and recovers only the configured Agent", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vitehub-shared-process-host-"));
  const store = createMemoryAgentInvocationStore();
  for (const [id, agentName] of [["owned", "worker"], ["other", "another-agent"]] as const) {
    await store.create({
      agentName,
      createdAt: "2020-01-01T00:00:00.000Z",
      id,
      observations: [],
      status: "running",
      traceId: id,
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
  }
  const invocations = defineAgentInvocations({ content: "content", store });
  const host = await createProcessAgentHost({
    dataDir,
    invocations,
    invocationAgentName: "worker",
    capacity: { concurrency: 1 },
    run: vi.fn(),
  });
  try {
    expect(host.invocations).toBe(invocations);
    await expect(host.invocations.get("owned")).resolves.toMatchObject({ status: "failed" });
    await expect(host.invocations.get("other")).resolves.toMatchObject({ status: "running" });
    await expect(stat(join(dataDir, "invocations.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(host.health()).resolves.toMatchObject({ workload: { stale: 0, total: 1 } });
  } finally {
    await host.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
