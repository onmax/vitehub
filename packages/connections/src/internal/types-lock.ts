import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import * as v from "valibot";

const ownerSchema = v.object({ pid: v.pipe(v.number(), v.integer(), v.minValue(1)) });
const ownerFilePattern = /^owner-[a-f0-9-]{36}\.json$/;
const abandonedEmptyLockMs = 30_000;
const acquisitionTimeoutMs = 10_000;

function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && "code" in error && codes.includes(String(error.code));
}

async function removeOwnedDirectory(directory: string, ownerFile: string): Promise<boolean> {
  try {
    // A replacement lock has a different guard filename. Never remove its guard.
    await unlink(resolve(directory, ownerFile));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
  try {
    // New owners publish nonempty directories, so rmdir cannot remove a replacement.
    await rmdir(directory);
  } catch (error) {
    if (!hasCode(error, "ENOENT", "ENOTEMPTY", "EEXIST")) throw error;
  }
  return true;
}

async function recoverAbandonedDirectory(directory: string): Promise<boolean> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    throw error;
  }
  if (files.length === 0) {
    // Earlier versions could leave an empty lock. Current owners never publish one.
    try {
      if (Date.now() - (await lstat(directory)).mtimeMs <= abandonedEmptyLockMs) return false;
      await rmdir(directory);
      return true;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return true;
      if (hasCode(error, "ENOTEMPTY", "EEXIST")) return false;
      throw error;
    }
  }
  if (files.length !== 1 || !ownerFilePattern.test(files[0]!)) return false;
  const ownerFile = files[0]!;
  let input: unknown;
  try {
    input = JSON.parse(await readFile(resolve(directory, ownerFile), "utf8"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  const owner = v.safeParse(ownerSchema, input);
  if (!owner.success) return false;
  try {
    process.kill(owner.output.pid, 0);
    return false;
  } catch (error) {
    // PID reuse and permission failures retain the lock. Only a confirmed exit permits recovery.
    if (!hasCode(error, "ESRCH")) return false;
  }
  return await removeOwnedDirectory(directory, ownerFile);
}

/** Serialize generated output with a nonempty, uniquely owned directory lock. */
export async function withConnectionsTypesLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(directory), { recursive: true });
  const token = randomUUID();
  const candidate = `${directory}.${token}.tmp`;
  const ownerFile = `owner-${token}.json`;
  await mkdir(candidate);
  let acquired = false;
  try {
    await writeFile(resolve(candidate, ownerFile), JSON.stringify({ pid: process.pid }));
    const deadline = Date.now() + acquisitionTimeoutMs;
    for (;;) {
      if (Date.now() >= deadline) throw Object.assign(new Error(`Timed out acquiring the Connections type generation lock ${JSON.stringify(directory)}.`), { code: "ELOCKED" });
      try {
        // Atomic publication makes the guard visible with the lock, without an empty-owner gap.
        await rename(candidate, directory);
        acquired = true;
        break;
      } catch (error) {
        const existing = await lstat(directory).catch(cause => {
          if (hasCode(cause, "ENOENT")) return undefined;
          throw cause;
        });
        if (!existing?.isDirectory()) throw error;
        if (await recoverAbandonedDirectory(directory)) continue;
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(20, deadline - Date.now())));
      }
    }
    return await action();
  } finally {
    if (acquired) await removeOwnedDirectory(directory, ownerFile);
    await rm(candidate, { force: true, recursive: true });
  }
}
