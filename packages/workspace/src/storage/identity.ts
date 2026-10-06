import type { WorkspaceStore } from "../core/types.ts"

const aliases = new WeakMap<object, object>()

export function workspaceStoreIdentity(store: Pick<WorkspaceStore, "getMeta">): object {
  let identity: object = store
  const seen = new Set<object>()
  while (true) {
    const next = aliases.get(identity)
    if (!next || seen.has(next)) return identity
    seen.add(identity)
    identity = next
  }
}

// Wrappers share volatile metadata while retaining their own mutation guards.
export function registerWorkspaceStoreAlias(alias: WorkspaceStore, store: WorkspaceStore): void {
  aliases.set(alias, workspaceStoreIdentity(store))
}
