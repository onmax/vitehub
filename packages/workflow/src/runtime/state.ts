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

// Execution retains its state through the completion callback. When GC APIs
// exist, inspection does not keep an abandoned promise and its payload alive.
type ActiveRunReference = WeakRef<WorkflowRunState> | WorkflowRunState
const runs = new Map<string, ActiveRunReference>()
// Without GC APIs, bound strong inspection ownership independently of history.
const fallbackRunKeys = new Set<string>()
let collectedRuns: FinalizationRegistry<{ key: string, reference: WeakRef<WorkflowRunState> }> | undefined
const completedRuns = new Map<string, WorkflowRunState>()

function isWeakReference(reference: ActiveRunReference): reference is WeakRef<WorkflowRunState> {
  return reference !== null && "deref" in reference
}

function getRunKey(name: string, id: string): string {
  return `${name}\0${id}`
}

function pruneWorkflowRuns(): void {
  const now = Date.now()
  for (const [key, run] of completedRuns) {
    if (run.expiresAt && run.expiresAt <= now) {
      completedRuns.delete(key)
    }
  }
  while (completedRuns.size > RUNS_LIMIT) {
    completedRuns.delete(completedRuns.keys().next().value!)
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
  const key = getRunKey(name, id)
  const canUseWeakReferences = globalThis.WeakRef !== undefined && globalThis.FinalizationRegistry !== undefined
  if (canUseWeakReferences) {
    collectedRuns ??= new FinalizationRegistry(({ key, reference }) => {
      if (runs.get(key) === reference) runs.delete(key)
    })
  }
  const previous = runs.get(key)
  if (previous && canUseWeakReferences) collectedRuns?.unregister(previous)
  fallbackRunKeys.delete(key)
  completedRuns.delete(key)
  const state: WorkflowRunState<TResult> = {
    promise: promise.then((resolved) => {
      state.status = resolved.status
      state.result = resolved.result
      state.error = resolved.error
      state.expiresAt = Date.now() + RUNS_TTL_MS
      const active = runs.get(key)
      const activeState = active && isWeakReference(active) ? active.deref() : active
      if (activeState === state) {
        runs.delete(key)
        fallbackRunKeys.delete(key)
        if (isWeakReference(reference)) collectedRuns?.unregister(reference)
        completedRuns.set(key, state)
        pruneWorkflowRuns()
      }
      return resolved
    }),
    status: "running",
  }
  const reference: ActiveRunReference = canUseWeakReferences ? new WeakRef(state) : state
  runs.set(key, reference)
  if (isWeakReference(reference)) collectedRuns?.register(state, { key, reference }, reference)
  else {
    fallbackRunKeys.add(key)
    while (fallbackRunKeys.size > RUNS_LIMIT) {
      const oldest = fallbackRunKeys.values().next().value!
      fallbackRunKeys.delete(oldest)
      runs.delete(oldest)
    }
  }
  return state
}

export function getWorkflowRunState(name: string, id: string): WorkflowRunState | undefined {
  pruneWorkflowRuns()
  const key = getRunKey(name, id)
  const reference = runs.get(key)
  const state = reference && isWeakReference(reference) ? reference.deref() : reference
  if (reference && !state) {
    runs.delete(key)
    if (isWeakReference(reference)) collectedRuns?.unregister(reference)
  }
  return state ?? completedRuns.get(key)
}

export function resetWorkflowRuntime(): void {
  runtimeConfig = undefined
  resetWorkflowDefinitions()
  fallbackEvent = undefined
  for (const reference of runs.values()) {
    if (isWeakReference(reference)) collectedRuns?.unregister(reference)
  }
  runs.clear()
  fallbackRunKeys.clear()
  completedRuns.clear()
}
