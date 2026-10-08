import { execFile } from "node:child_process";
import { chmod, cp, lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const yarnOutputs = new Set(["cache", "unplugged", "install-state.gz"]);
const rootOutputs = new Set([".pnp.cjs", ".pnp.loader.mjs", ".pnp.data.json"]);

export interface GitHubInstallSnapshot {
  checkout: string;
  directory: string;
  identities: ReadonlyMap<string, { dev: string; ino: string }>;
  close(): Promise<void>;
}

/** Copy mutable provider inputs into a private host directory before validation. */
export async function createGitHubInstallSnapshot(target: string): Promise<GitHubInstallSnapshot> {
  const checkout = await realpath(target);
  const directory = await mkdtemp(join(tmpdir(), "vitehub-dependency-snapshot-"));
  const identities = new Map<string, { dev: string; ino: string }>();
  try {
    await cp(checkout, directory, {
      recursive: true, dereference: false, verbatimSymlinks: true,
      filter: async source => {
        const path = relative(checkout, source);
        const parts = path.split(sep);
        if ([".git", "node_modules"].includes(basename(source))
          || rootOutputs.has(path) || parts[0] === ".yarn" && yarnOutputs.has(parts[1]!)) return false;
        const info = await lstat(source, { bigint: true });
        if (path === ".yarn" && !info.isDirectory()) throw new Error("Yarn installation output must use a regular checkout directory.");
        if (info.isDirectory()) identities.set(path, { dev: String(info.dev), ino: String(info.ino) });
        return true;
      },
    });
    await chmod(directory, 0o700);
    return { checkout, directory, identities, close: async () => await rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Publish package-manager outputs without following replaced provider directories. */
export async function publishGitHubInstallSnapshot(snapshot: GitHubInstallSnapshot, signal?: AbortSignal): Promise<void> {
  let outputDirectory = snapshot.directory;
  let transfer: string | undefined;
  // TMPDIR can use another filesystem. Stage output under protected Git
  // metadata so each publication can still use an atomic local rename.
  if (String((await lstat(outputDirectory, { bigint: true })).dev) !== snapshot.identities.get("")?.dev) {
    transfer = await mkdtemp(join(snapshot.checkout, ".git", "vitehub-dependency-output-"));
    try { await cp(outputDirectory, transfer, { recursive: true, dereference: false, verbatimSymlinks: true }); }
    catch (error) { await rm(transfer, { recursive: true, force: true }); throw error; }
    outputDirectory = transfer;
  }
  async function publish(path: string, names: string[], yarn = false) {
    const identity = snapshot.identities.get(path);
    if (!identity) throw new Error("Dependency output directory changed during installation.");
    // Starting a child pins cwd before checking its identity. All destination
    // operations stay relative to that inode even if the provider renames it.
    await exec(process.execPath, ["--input-type=module", "--eval", `
      import { lstat, mkdir, rename, rm } from "node:fs/promises";
      import { join } from "node:path";
      const [dev, ino, source, names, yarn] = process.argv.slice(1);
      const info = await lstat(".", { bigint: true });
      if (String(info.dev) !== dev || String(info.ino) !== ino) throw new Error("Dependency output directory changed during installation.");
      if (yarn === "true") {
        await mkdir(".yarn").catch(error => { if (error.code !== "EEXIST") throw error; });
        const expected = await lstat(".yarn", { bigint: true });
        if (!expected.isDirectory()) throw new Error("Yarn output directory must not be a symbolic link.");
        process.chdir(".yarn");
        const actual = await lstat(".", { bigint: true });
        if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error("Yarn output directory changed during installation.");
      }
      for (const name of JSON.parse(names)) {
        await rm(name, { recursive: true, force: true });
        await rename(join(source, name), name);
      }
    `, identity.dev, identity.ino, join(outputDirectory, path, yarn ? ".yarn" : ""), JSON.stringify(names), String(yarn)], {
      cwd: join(snapshot.checkout, path), signal,
    });
  }
  async function visit(path: string) {
    const outputs: string[] = [];
    for (const entry of await readdir(join(outputDirectory, path), { withFileTypes: true })) {
      if (entry.name === "node_modules" || !path && rootOutputs.has(entry.name)) outputs.push(entry.name);
      else if (!path && entry.name === ".yarn") {
        const names = (await readdir(join(outputDirectory, ".yarn"))).filter(name => yarnOutputs.has(name));
        if (names.length) await publish("", names, true);
      } else if (entry.isDirectory()) await visit(join(path, entry.name));
    }
    if (outputs.length) await publish(path, outputs);
  }
  try { await visit(""); }
  finally { if (transfer) await rm(transfer, { recursive: true, force: true }); }
}
