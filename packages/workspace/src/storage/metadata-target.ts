import { hasRuntimeType } from "../internal/runtime-type.ts"
import { forwardWorkspaceStoreTarget } from "./target.ts"
import type { ListOptions, MkdirOptions, RmOptions, WorkspaceEntry, WorkspaceFile } from "../core/types.ts"

export interface WorkspaceMetadataTarget {
  workspaceName?: string
  readFile?(path: string): Promise<WorkspaceFile | undefined>
  writeFile?(path: string, file: WorkspaceFile): Promise<void>
  mkdir?(path: string, options?: MkdirOptions): Promise<void>
  rm?(path: string, options?: RmOptions): Promise<void>
  getMeta?(key: string): Promise<unknown>
  /** Owner-only metadata write. It accepts internal keys that public `setMeta` rejects. */
  setMeta?(key: string, value: unknown): Promise<void>
  list?(path: string, options?: ListOptions): Promise<WorkspaceEntry[]>
}

type WorkspaceMetadataTargetResolver = () => Promise<WorkspaceMetadataTarget | undefined> | WorkspaceMetadataTarget | undefined

// A metadata target can write to the raw Store and skip every write grant.
// Keep the resolvers in this module. Do not export them from a package entry.
const metadataTargetResolvers = new WeakMap<object, WorkspaceMetadataTargetResolver>()

const metadataTargetsByStore = new WeakMap<WorkspaceMetadataTarget, Map<string, WorkspaceMetadataTarget>>()

export function createWorkspaceMetadataTarget(store: WorkspaceMetadataTarget, workspaceName: string): WorkspaceMetadataTarget {
  const targets = metadataTargetsByStore.get(store) ?? new Map<string, WorkspaceMetadataTarget>()
  const existing = targets.get(workspaceName)
  if (existing) return existing
  const target: WorkspaceMetadataTarget = {
    workspaceName,
    readFile: store.readFile?.bind(store),
    writeFile: store.writeFile?.bind(store),
    mkdir: store.mkdir?.bind(store),
    rm: store.rm?.bind(store),
    getMeta: store.getMeta?.bind(store),
    setMeta: store.setMeta?.bind(store),
    list: store.list?.bind(store),
  }
  forwardWorkspaceStoreTarget(store, target)
  targets.set(workspaceName, target)
  metadataTargetsByStore.set(store, targets)
  return target
}

export function attachWorkspaceMetadataTarget(carrier: object, resolve: WorkspaceMetadataTargetResolver): void {
  metadataTargetResolvers.set(carrier, resolve)
}

export function forwardWorkspaceMetadataTarget(source: unknown, target: object): void {
  const resolve = metadataTargetResolver(source)
  if (resolve) metadataTargetResolvers.set(target, resolve)
}

export async function resolveWorkspaceMetadataTarget(source: unknown): Promise<WorkspaceMetadataTarget | undefined> {
  return await metadataTargetResolver(source)?.()
}

/**
 * Attaches a read-only metadata view of `source` to `target`.
 * The view has the Workspace name, `getMeta`, `list`, and the Store target. It never has Store writes.
 * `filterEntries` limits the listed entries, for example to an access scope.
 * Internal: `@vite-hub/agent` uses this for its Workspace facades.
 */
export function forwardWorkspaceMetadataView(source: unknown, target: object, filterEntries?: (entries: WorkspaceEntry[]) => WorkspaceEntry[]): void {
  const resolve = metadataTargetResolver(source)
  if (!resolve) return
  metadataTargetResolvers.set(target, async () => {
    const metadata = await resolve()
    if (!metadata) return
    const list = metadata.list?.bind(metadata)
    const view: WorkspaceMetadataTarget = {
      workspaceName: metadata.workspaceName,
      getMeta: metadata.getMeta?.bind(metadata),
      list: list
        ? async (path, options) => {
            const entries = await list(path, options)
            return filterEntries ? filterEntries(entries) : entries
          }
        : undefined,
    }
    forwardWorkspaceStoreTarget(metadata, view)
    return view
  })
}

function metadataTargetResolver(source: unknown) {
  if (source === null || !(hasRuntimeType(source, "object") || hasRuntimeType(source, "function"))) return undefined
  return metadataTargetResolvers.get(source)
}
