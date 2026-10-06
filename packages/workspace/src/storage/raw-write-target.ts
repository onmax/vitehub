import type { MkdirOptions, RmOptions, WriteFileOptions, WorkspaceContent } from "../core/types.ts"

export const workspaceRawWriteTarget = Symbol.for("vitehub.workspace.rawWriteTarget")

export type WorkspaceRawWriteTarget = {
  writeFile(path: string, content: WorkspaceContent, options?: WriteFileOptions): Promise<string>
  mkdir(path: string, options?: MkdirOptions): Promise<void>
  rm(path: string, options?: RmOptions): Promise<void>
}

type Carrier = { [workspaceRawWriteTarget]?: WorkspaceRawWriteTarget }

export function setWorkspaceRawWriteTarget(workspace: object, target: WorkspaceRawWriteTarget): void {
  ;(workspace as Carrier)[workspaceRawWriteTarget] = target
}

export function resolveWorkspaceRawWriteTarget(workspace: object): WorkspaceRawWriteTarget | undefined {
  return (workspace as Carrier)[workspaceRawWriteTarget]
}
