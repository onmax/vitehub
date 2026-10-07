import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, rmdir, statfs, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defineDiagnostics } from "nostics";

export interface TrustedHostResources {
  /** Writable delegated cgroup v2 parent. The controller must live in a separate subgroup. */
  cgroupParent: string;
  /** Aggregate resident memory limit for this session's commands and descendants. */
  memoryMaxBytes: number;
  memoryHighBytes?: number;
  /** Aggregate swap limit. Defaults to zero. */
  memorySwapMaxBytes?: number;
}

const diagnostics = defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/diagnostics",
  codes: {
    BOX_R0157: { why: ({ message }: { message: string }) => message },
    BOX_R0158: { why: ({ message }: { message: string }) => message },
  },
});

export function validateTrustedHostResources(resources: TrustedHostResources): void {
  if (process.platform !== "linux" || !isAbsolute(resources.cgroupParent)) {
    throw diagnostics.BOX_R0157({ message: "Box memory limits require Linux and an absolute delegated cgroupParent." });
  }
  for (const [key, value] of Object.entries({
    memoryMaxBytes: resources.memoryMaxBytes,
    memoryHighBytes: resources.memoryHighBytes ?? resources.memoryMaxBytes,
    memorySwapMaxBytes: resources.memorySwapMaxBytes ?? 0,
  })) {
    if (!Number.isSafeInteger(value) || value < 0 || (key !== "memorySwapMaxBytes" && value === 0)) {
      throw diagnostics.BOX_R0157({ message: `Box ${key} must be a safe integer byte limit.` });
    }
  }
  if ((resources.memoryHighBytes ?? resources.memoryMaxBytes) > resources.memoryMaxBytes) {
    throw diagnostics.BOX_R0157({ message: "Box memoryHighBytes must not exceed memoryMaxBytes." });
  }
}

export interface SessionMemory {
  assertHealthy(): Promise<void>;
  spawn(command: string, options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams;
  kill(): Promise<void>;
  close(): Promise<void>;
}

export async function createSessionMemory(resources: TrustedHostResources): Promise<SessionMemory> {
  validateTrustedHostResources(resources);
  const parent = resources.cgroupParent;
  // Never silently create ordinary files in a directory that is not a cgroup mount.
  if ((await statfs(parent)).type !== 0x63677270) {
    throw diagnostics.BOX_R0157({ message: "Box cgroupParent must be on a cgroup v2 filesystem." });
  }
  const controllers = (await readFile(join(parent, "cgroup.controllers"), "utf8")).trim().split(/\s+/);
  if (!controllers.includes("memory")) {
    throw diagnostics.BOX_R0157({ message: "Box cgroupParent does not delegate the memory controller." });
  }
  await writeFile(join(parent, "cgroup.subtree_control"), "+memory");
  const path = join(parent, `vitehub-box-${randomUUID()}`);
  await mkdir(path);
  try {
    await writeFile(join(path, "memory.max"), String(resources.memoryMaxBytes));
    if (resources.memoryHighBytes !== undefined) await writeFile(join(path, "memory.high"), String(resources.memoryHighBytes));
    await writeFile(join(path, "memory.swap.max"), String(resources.memorySwapMaxBytes ?? 0));
    // Kill the whole worker, including its compiler and provider, on a local OOM.
    await writeFile(join(path, "memory.oom.group"), "1");
    await access(join(path, "cgroup.procs"), constants.W_OK);
    await access(join(path, "cgroup.kill"), constants.W_OK);
  } catch (error) {
    await rmdir(path);
    throw error;
  }
  let closed = false;
  return {
    async assertHealthy() {
      if (closed) throw diagnostics.BOX_R0157({ message: "Box resource group is closed." });
      const events = await readFile(join(path, "memory.events"), "utf8");
      const kills = Number(/^oom_kill (\d+)/m.exec(events)?.[1] ?? 0);
      const localEvents = await readFile(join(path, "memory.events.local"), "utf8");
      const localOom = Number(/^oom (\d+)/m.exec(localEvents)?.[1] ?? 0);
      // oom_kill also includes kills initiated by an ancestor cgroup or the host.
      // Only local oom events prove that this session hit memory.max.
      if (kills > 0 && localOom > 0) {
        const peak = await readFile(join(path, "memory.peak"), "utf8")
          .then(contents => contents.trim())
          .catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "unavailable" : Promise.reject(error));
        throw diagnostics.BOX_R0158({ message: `Box memory limit exceeded: limit=${resources.memoryMaxBytes} bytes, peak=${peak} bytes, oom_kill=${kills}. Retry only after reducing the workload or changing its budget.` });
      }
    },
    spawn(command: string, options: SpawnOptionsWithoutStdio) {
      // Join the cgroup before starting the command. Startup hooks are restored only
      // after that move, so caller-controlled loaders cannot fork outside the limit.
      const environment = Object.entries(options.env ?? process.env).filter((entry): entry is [string, string] => entry[1] !== undefined);
      return spawn("/bin/sh", [
        "-c",
        'printf "%s" "$$" > "$1/cgroup.procs" || exit 125; shift; exec /usr/bin/env -i -- "$@"',
        "vitehub-box",
        path,
        ...environment.map(([name, value]) => `${name}=${value}`),
        "/bin/sh",
        "-c",
        command,
      ], { ...options, env: {} });
    },
    async kill() {
      if (!closed) await writeFile(join(path, "cgroup.kill"), "1");
    },
    async close() {
      if (closed) return;
      await writeFile(join(path, "cgroup.kill"), "1");
      // A killed process can remain in the group until the kernel finishes exit.
      for (let attempt = 0; ; attempt++) {
        try {
          await removeDescendantCgroups(path);
          await rmdir(path);
          closed = true;
          return;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "EBUSY" || attempt === 39) throw error;
          await delay(25);
        }
      }
    },
  };
}

async function removeDescendantCgroups(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(path, entry.name);
    await removeDescendantCgroups(child);
    await rmdir(child);
  }
}
