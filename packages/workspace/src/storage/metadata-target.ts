export const workspaceMetadataTarget: unique symbol = Symbol.for("vitehub.workspace.metadataTarget")
/** Internal capability used only by Source Sync through wrapped writable facades. */
export const workspaceInternalMetadataCapability: unique symbol = Symbol("vitehub.workspace.internalMetadata")

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
  setMeta?(key: string, value: unknown, capability?: typeof workspaceInternalMetadataCapability): Promise<void>
}

const metadataTargetsByStore = new WeakMap<WorkspaceMetadataTarget, Map<string, WorkspaceMetadataTarget>>()
const metadataSetters = new WeakMap<WorkspaceMetadataTarget, (key: string, value: unknown, capability?: typeof workspaceInternalMetadataCapability) => Promise<void>>()
const publicMetadataTargets = new WeakMap<WorkspaceMetadataTarget, WorkspaceMetadataTarget>()
const facadeMetadataTargets = new WeakMap<object, () => Promise<WorkspaceMetadataTarget | undefined>>()
const privateMetadataTargets = new WeakMap<WorkspaceMetadataTarget, WorkspaceMetadataTarget>()

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
  const publicTarget = {
    workspaceName,
    readFile: target.readFile,
    getMeta: target.getMeta,
    list: target.list,
  }
  publicMetadataTargets.set(target, publicTarget)
  privateMetadataTargets.set(publicTarget, target)
  forwardWorkspaceStoreTarget(store, target)
  forwardWorkspaceStoreTarget(store, publicTarget)
  targets.set(workspaceName, publicTarget)
  metadataTargetsByStore.set(store, targets)
  return publicTarget
}

/** Writes internal metadata without exposing the privileged setter on a facade. */
export async function setWorkspaceMetadata(target: WorkspaceMetadataTarget, key: string, value: unknown): Promise<boolean> {
  const setter = metadataSetters.get(target) || metadataSetters.get(privateMetadataTargets.get(target) ?? target)
  if (!setter) return false
  await setter(key, value, workspaceInternalMetadataCapability)
  return true
}

export type WorkspaceMetadataTargetCarrier = {
  [workspaceMetadataTarget]?: () => Promise<WorkspaceMetadataTarget | undefined> | WorkspaceMetadataTarget | undefined
}

export function forwardWorkspaceMetadataTarget(source: unknown, target: unknown): void {
  // SAFETY: Forwarding probes only this module's optional metadata resolver symbol.
  const resolveTarget = (source as WorkspaceMetadataTargetCarrier)[workspaceMetadataTarget]
  if (!resolveTarget) return
  const resolve = async () => publicMetadataTarget(await resolveTarget.call(source))
  // SAFETY: The target is a facade object; this writes only our metadata resolver symbol.
  const targetCarrier = target as WorkspaceMetadataTargetCarrier
  targetCarrier[workspaceMetadataTarget] = resolve
  // SAFETY: Facades may have a filesystem object used only as a WeakMap identity.
  const fs = (target as { fs?: object }).fs
  if (fs) facadeMetadataTargets.set(fs, resolve)
}

function publicMetadataTarget(target: WorkspaceMetadataTarget | undefined) {
  return target ? publicMetadataTargets.get(target) ?? target : undefined
}

export async function resolveWorkspaceMetadataTarget(source: unknown): Promise<WorkspaceMetadataTarget | undefined> {
  // SAFETY: Only the optional resolver symbol and filesystem identity are probed on the supplied facade.
  const carrier = source as WorkspaceMetadataTargetCarrier & { fs?: object }
  const target = await carrier[workspaceMetadataTarget]?.()
    ?? (carrier.fs ? await facadeMetadataTargets.get(carrier.fs)?.() : undefined)
  return publicMetadataTarget(target)
}

export function resolveWorkspaceMetadataMutationTarget(target: WorkspaceMetadataTarget): WorkspaceMetadataTarget {
  return privateMetadataTargets.get(target) ?? target
}
