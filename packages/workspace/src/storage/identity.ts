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
  const aliasIdentity = workspaceStoreIdentity(alias)
  const storeIdentity = workspaceStoreIdentity(store)
  if (aliasIdentity === storeIdentity) return

  // A facade can be resolved more than once. If it reuses an existing Store
  // wrapper, merge the new target into the identity it already owns instead
  // of replacing that identity and splitting the mutation queue.
  aliases.set(aliases.has(alias) ? storeIdentity : aliasIdentity, aliases.has(alias) ? aliasIdentity : storeIdentity)
}
