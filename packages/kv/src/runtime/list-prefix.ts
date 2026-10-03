import { normalizeKey } from "unstorage"

export function normalizeKVListPrefix(prefix = ""): string {
  const normalized = normalizeKey(prefix)
  // A trailing separator restricts the listing to children of this key.
  const path = prefix.split("?")[0] ?? ""
  return normalized && /[:/\\]$/.test(path) ? `${normalized}:` : normalized
}
