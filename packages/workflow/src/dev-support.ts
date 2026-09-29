import type { WorkflowProvider, WorkflowRunStatus } from "./types.ts"

/**
 * Guarded Workflow dev endpoint on the Vite Development Server.
 *
 * The endpoint exists only on the development server. It is not an
 * authenticated path to a deployed stage.
 */
export const workflowDevRoute = "/__vitehub/workflow/dev"
export const workflowDevHeader = "x-vitehub-workflow-dev"
export const workflowDevHeaderValue = "1"

export const workflowDevOperations = ["start", "get", "cancel", "resume"] as const
export type WorkflowDevOperation = typeof workflowDevOperations[number]

export interface WorkflowDevOperationSupport {
  /** Explains what the local dev runtime does, or why it cannot do the operation. */
  note: string
  supported: boolean
}

export type WorkflowDevSupport = Record<WorkflowDevOperation, WorkflowDevOperationSupport>

export interface WorkflowDevDiscovery {
  /** Configuration error that stops the local dev runtime. */
  error?: string
  operations: WorkflowDevSupport
  /** Active Workflow Provider, or `null` when Workflow is disabled or not configured. */
  provider: WorkflowProvider | null
  root: string
  /** Discovered Workflow Definitions that the CLI can start. */
  workflows: string[]
}

export type WorkflowDevRequest =
  | { input?: unknown, operation: "start", workflow: string }
  | { operation: "cancel" | "get", runId: string, workflow?: string }
  | { operation: "resume", payload?: unknown, token: string }

export interface WorkflowDevRunView {
  completedAt?: string
  createdAt?: string
  error?: { code?: string, message: string, name?: string }
  id: string
  metadata?: unknown
  provider: WorkflowProvider
  result?: unknown
  startedAt?: string
  status: WorkflowRunStatus
  workflow: string
}

export interface WorkflowDevSignalView {
  id: string
  provider: WorkflowProvider
}

export interface WorkflowDevErrorBody {
  error: {
    code: string
    message: string
  }
}

export type WorkflowDevResponseBody =
  | { run: WorkflowDevRunView }
  | { signal: WorkflowDevSignalView }
  | WorkflowDevErrorBody

const inlineRunNote = "Runs the Workflow inline in the Vite Development Server process. The run is not durable and has no retries."
const inlineReadNote = "Reads inline runs that the CLI started on this Vite Development Server. Runs that the app starts are not visible. Finished runs expire after 5 minutes."

function unsupported(note: string): WorkflowDevOperationSupport {
  return { note, supported: false }
}

/**
 * Operations that the local Workflow dev runtime supports for each provider.
 *
 * The CLI runs Workflows in the Vite Development Server process. Provider
 * bindings, Workflow DevKit runs, and OpenWorkflow workers do not exist there,
 * so each entry states what the command really does.
 */
export function resolveWorkflowDevSupport(provider: WorkflowProvider | null, reason?: string): WorkflowDevSupport {
  if (!provider) {
    const note = reason || "Workflow is disabled in this app."
    return { cancel: unsupported(note), get: unsupported(note), resume: unsupported(note), start: unsupported(note) }
  }
  if (provider === "cloudflare") {
    return {
      cancel: unsupported("Cloudflare Workflows do not support cancellation through ViteHub."),
      get: { note: `${inlineReadNote} Runs in Cloudflare Workflow bindings are not visible.`, supported: true },
      resume: unsupported("Cloudflare Workflows do not support ViteHub signals."),
      start: { note: `${inlineRunNote} Cloudflare Workflow bindings exist only in the Workers runtime.`, supported: true },
    }
  }
  if (provider === "openworkflow") {
    return {
      cancel: unsupported("OpenWorkflow does not support cancellation through ViteHub."),
      get: { note: "Reads the run from OpenWorkflow storage, including runs that the app started.", supported: true },
      resume: unsupported("OpenWorkflow does not support ViteHub signals."),
      start: { note: "Enqueues the run in OpenWorkflow storage. The Vite Development Server does not start an OpenWorkflow worker, so the run stays queued until a worker processes the same storage.", supported: true },
    }
  }
  return {
    cancel: unsupported("Inline Vercel runs cannot be cancelled. Cancellation needs a native Vercel Workflow run, which the local dev runtime does not start."),
    get: { note: inlineReadNote, supported: true },
    resume: unsupported("Signals need a native Vercel Workflow run. The local dev runtime runs Vercel Workflows inline and creates no signal tokens."),
    start: { note: `${inlineRunNote} It is not a Vercel Workflow DevKit run.`, supported: true },
  }
}
