export const workspaceMetadataTarget: unique symbol = Symbol.for("vitehub.workspace.metadataTarget")

import { forwardWorkspaceStoreTarget } from "./target.ts"
import type { ListOptions, MkdirOptions, RmOptions, WorkspaceEntry, WorkspaceFile } from "../core/types.ts"

export interface WorkspaceMetadataTarget {
  workspaceName?: string
  readFile?(path: string): Promise<WorkspaceFile | undefined>
  writeFile?(path: string, file: WorkspaceFile): Promise<void>
  mkdir?(path: string, options?: MkdirOptions): Promise<void>
  rm?(path: string, options?: RmOptions): Promise<void>
  getMeta?(key: string): Promise<unknown>
  list?(path: string, options?: ListOptions): Promise<WorkspaceEntry[]>
}

type WorkspaceMetadataStore = WorkspaceMetadataTarget & {
  setMeta?(key: string, value: unknown): Promise<void>
}

const metadataTargetsByStore = new WeakMap<WorkspaceMetadataTarget, Map<string, WorkspaceMetadataTarget>>()
const metadataSetters = new WeakMap<WorkspaceMetadataTarget, (key: string, value: unknown) => Promise<void>>()

export function createWorkspaceMetadataTarget(store: WorkspaceMetadataStore, workspaceName: string): WorkspaceMetadataTarget {
  const targets = metadataTargetsByStore.get(store) ?? new Map<string, WorkspaceMetadataTarget>()
  const existing = targets.get(workspaceName)
  if (existing) return existing
  const setMeta = store.setMeta?.bind(store)
  const target: WorkspaceMetadataTarget = {
    workspaceName,
    readFile: store.readFile?.bind(store),
    writeFile: store.writeFile?.bind(store),
    mkdir: store.mkdir?.bind(store),
    rm: store.rm?.bind(store),
    getMeta: store.getMeta?.bind(store),
    list: store.list?.bind(store),
  }
  if (setMeta) metadataSetters.set(target, setMeta)
  forwardWorkspaceStoreTarget(store, target)
  targets.set(workspaceName, target)
  metadataTargetsByStore.set(store, targets)
  return target
}

/** Writes internal metadata without exposing the privileged setter on a facade. */
export async function setWorkspaceMetadata(target: WorkspaceMetadataTarget, key: string, value: unknown): Promise<boolean> {
  const setter = metadataSetters.get(target)
  if (!setter) return false
  await setter(key, value)
  return true
}

export type WorkspaceMetadataTargetCarrier = {
  [workspaceMetadataTarget]?: () => Promise<WorkspaceMetadataTarget | undefined> | WorkspaceMetadataTarget | undefined
}

export function forwardWorkspaceMetadataTarget(source: unknown, target: unknown): void {
  // SAFETY: Metadata target forwarding probes only the private symbol member owned by this module.
  const resolveTarget = (source as WorkspaceMetadataTargetCarrier)[workspaceMetadataTarget]
  // SAFETY: Metadata target forwarding writes only the private symbol member owned by this module.
  if (resolveTarget) (target as WorkspaceMetadataTargetCarrier)[workspaceMetadataTarget] = resolveTarget.bind(source)
}

export async function resolveWorkspaceMetadataTarget(source: unknown): Promise<WorkspaceMetadataTarget | undefined> {
  // SAFETY: Metadata target forwarding probes only the private symbol member owned by this module.
  return await (source as WorkspaceMetadataTargetCarrier)[workspaceMetadataTarget]?.()
}
