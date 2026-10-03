import { AsyncLocalStorage } from "node:async_hooks"

import type { ResolvedWorkflowOptions } from "../types.ts"
import { resetWorkflowDefinitions } from "./definitions.ts"

export { getInlineWorkflowDefinitions, getWorkflowRuntimeRegistry, loadWorkflowDefinition, registerInlineWorkflowDefinition, setWorkflowRuntimeRegistry, takeInlineWorkflowDefinition, takeInlineWorkflowDefinitionForModule } from "./definitions.ts"

const RUNS_LIMIT = 1024
const RUNS_TTL_MS = 5 * 60 * 1000

let runtimeConfig: false | ResolvedWorkflowOptions | undefined
let fallbackEvent: unknown
const eventStorage = new AsyncLocalStorage<unknown>()

export interface WorkflowRunState<TResult = unknown> {
  error?: unknown
  expiresAt?: number
  promise: Promise<{ result?: TResult, status: "completed" | "failed", error?: unknown }>
  result?: TResult
  status: "running" | "completed" | "failed"
}

const runs = new Map<string, WorkflowRunState>()

function getRunKey(name: string, id: string): string {
  return `${name}\0${id}`
}

function pruneWorkflowRuns(): void {
  const now = Date.now()
  for (const [key, run] of runs) {
    if (run.expiresAt && run.expiresAt <= now) {
      runs.delete(key)
    }
  }
}

export function setWorkflowRuntimeConfig(config: false | ResolvedWorkflowOptions | undefined): void {
  runtimeConfig = config
}

export function getWorkflowRuntimeConfig(): false | ResolvedWorkflowOptions | undefined {
  return runtimeConfig
}

export function enterWorkflowRuntimeEvent(event: unknown): void {
  fallbackEvent = event
  try {
    eventStorage.enterWith(event)
  }
  catch {}
}

export function getWorkflowRuntimeEvent(): unknown {
  return eventStorage.getStore() ?? fallbackEvent
}

export async function runWithWorkflowRuntimeEvent<T>(event: unknown, run: () => T | Promise<T>): Promise<T> {
  return await eventStorage.run(event, run)
}

export function setWorkflowRun<TResult = unknown>(
  name: string,
  id: string,
  promise: Promise<{ result?: TResult, status: "completed" | "failed", error?: unknown }>,
): WorkflowRunState<TResult> {
  pruneWorkflowRuns()
  if (runs.size >= RUNS_LIMIT) {
    const oldest = runs.keys().next().value
    if (oldest !== undefined) runs.delete(oldest)
  }
  const state: WorkflowRunState<TResult> = {
    promise: promise.then((resolved) => {
      state.status = resolved.status
      state.result = resolved.result
      state.error = resolved.error
      state.expiresAt = Date.now() + RUNS_TTL_MS
      return resolved
    }),
    status: "running",
  }
  runs.set(getRunKey(name, id), state)
  return state
}

export function getWorkflowRunState(name: string, id: string): WorkflowRunState | undefined {
  pruneWorkflowRuns()
  return runs.get(getRunKey(name, id))
}

export function resetWorkflowRuntime(): void {
  runtimeConfig = undefined
  resetWorkflowDefinitions()
  fallbackEvent = undefined
  runs.clear()
}
