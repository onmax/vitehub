import { useWorkspace } from "./core/use.ts"
import { createWorkspaceCollectionQuery } from "./collections/query.ts"

import type { ReadonlyWorkspaceFacade } from "./core/use.ts"
import type { WorkspaceName } from "./core/types.ts"
import { workspaceErrorDiagnostics } from "./error-diagnostics.ts"

export interface WorkspaceCollectionEmptyFilter {
  empty: true
}

export const workspaceCollectionEmpty: WorkspaceCollectionEmptyFilter = Object.freeze({ empty: true })

export type WorkspaceCollectionFilter = string | string[] | WorkspaceCollectionEmptyFilter

export interface WorkspaceCollectionSort {
  direction?: "asc" | "desc"
  field: string
}

export interface WorkspaceCollectionQuery {
  cursor?: string
  facets?: string[]
  filters?: Record<string, WorkspaceCollectionFilter | undefined>
  limit?: number
  search?: string
  searchFields?: string[]
  select?: string[]
  sort?: WorkspaceCollectionSort
}

export interface WorkspaceCollectionItemQuery {
  key: string
  select?: string[]
  value: string | number
}

export interface WorkspaceCollectionOptions<Name extends WorkspaceName = WorkspaceName> {
  defaultLimit?: number
  maxLimit?: number
  path: string
  workspace: Name | ReadonlyWorkspaceFacade<Name> | Promise<ReadonlyWorkspaceFacade<Name>>
}

export interface WorkspaceCollectionPageOptions<Name extends WorkspaceName = WorkspaceName> extends WorkspaceCollectionOptions<Name> {
  query?: WorkspaceCollectionQuery
}

export interface WorkspaceCollectionItemOptions<Name extends WorkspaceName = WorkspaceName> extends WorkspaceCollectionOptions<Name> {
  query: WorkspaceCollectionItemQuery
}

export interface WorkspaceCollectionFacetValue {
  count: number
  value: string
}

export interface WorkspaceCollectionPage<T = Record<string, unknown>> {
  digest: string
  facets: Record<string, WorkspaceCollectionFacetValue[]>
  items: T[]
  nextCursor: string | null
  total: number
}

export interface WorkspaceCollectionItem<T = Record<string, unknown>> {
  digest: string
  item: T | null
}

async function readCollection<Name extends WorkspaceName>(options: WorkspaceCollectionOptions<Name>) {
  const workspace = typeof options.workspace === "string" ? useWorkspace(options.workspace) : await options.workspace
  const stat = await workspace.fs.stat(options.path as never)
  if (stat.type !== "file") throw workspaceErrorDiagnostics.WORKSPACE_R0010({ message: `Workspace collection ${options.path} must be a file.` })

  const raw = await workspace.fs.readFile(options.path as never, { encoding: "utf8" })
  return await createWorkspaceCollectionQuery(raw, { digest: stat.digest, path: options.path })
}

export async function queryWorkspaceCollection<T = Record<string, unknown>, Name extends WorkspaceName = WorkspaceName>(
  options: WorkspaceCollectionPageOptions<Name>,
): Promise<WorkspaceCollectionPage<T>> {
  return await (await readCollection(options)).page<T>(options)
}

export async function getWorkspaceCollectionItem<T = Record<string, unknown>, Name extends WorkspaceName = WorkspaceName>(
  options: WorkspaceCollectionItemOptions<Name>,
): Promise<WorkspaceCollectionItem<T>> {
  return (await readCollection(options)).get<T>(options.query)
}
