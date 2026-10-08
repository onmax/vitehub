import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Stable across rebuilds, including previews that reuse the manifest version. */
export function agentBuildRevision(root: string): string {
  root = resolve(root);
  const paths = ["package.json", ...readdirSync(join(root, "src"), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(root.length + 1))].sort();
  const hash = createHash("sha256");
  for (const path of paths) hash.update(JSON.stringify([path.replaceAll("\\", "/"), readFileSync(join(root, path), "utf8")]));
  return hash.digest("hex");
}
