import { AsyncLocalStorage } from "node:async_hooks"

import type { WorkflowDefinition, WorkflowDefinitionRegistry } from "../types.ts"
import { workflowErrorDiagnostics } from "../error-diagnostics.ts"

function createRegistryState(registry?: WorkflowDefinitionRegistry) {
  return {
    registry,
    loaded: new Map<string, WorkflowDefinition | undefined>(),
    loading: new Map<string, Promise<WorkflowDefinition | undefined>>(),
    inlineLoads: new Set<Map<string, WorkflowDefinition>>(),
  }
}

type RegistryState = ReturnType<typeof createRegistryState>

let registryState = createRegistryState()
const inlineRegistry = new Map<string, WorkflowDefinition>()
const loadingRegistryStorage = new AsyncLocalStorage<{ names: Set<string>, state: RegistryState }>()
const loadingInlineRegistryStorage = new AsyncLocalStorage<{ definitions: Map<string, WorkflowDefinition>, state: RegistryState }>()

export function setWorkflowRuntimeRegistry(registry: WorkflowDefinitionRegistry | undefined): void {
  // Partial inline registrations belong to the registry that is being retired.
  for (const definitions of registryState.inlineLoads) {
    for (const [name, definition] of definitions) {
      consumeInlineWorkflowDefinition(name, definition)
    }
  }
  registryState = createRegistryState(registry)
}

export function getWorkflowRuntimeRegistry(): WorkflowDefinitionRegistry | undefined {
  return registryState.registry
}

export function getInlineWorkflowDefinitions(): ReadonlyMap<string, WorkflowDefinition> {
  return inlineRegistry
}

export function takeInlineWorkflowDefinition(name: string): WorkflowDefinition | undefined {
  const loading = loadingInlineRegistryStorage.getStore()
  const current = !loading || loading.state === registryState
  const definition = loading?.definitions.get(name) ?? (current ? inlineRegistry.get(name) : undefined)
  if (current) consumeInlineWorkflowDefinition(name, definition)
  loading?.definitions.delete(name)
  return definition
}

function isWorkflowHandle(value: unknown): value is { name: string } {
  return typeof value === "object"
    && value !== null
    && typeof (value as { name?: unknown }).name === "string"
    && typeof (value as { defer?: unknown }).defer === "function"
    && typeof (value as { getRun?: unknown }).getRun === "function"
    && typeof (value as { run?: unknown }).run === "function"
}

function findExportedInlineWorkflowDefinition(
  name: string,
  loaded: unknown,
  definitions: ReadonlyMap<string, WorkflowDefinition>,
): { definition: WorkflowDefinition, name: string } | undefined {
  const namedDefinition = definitions.get(name)
  if (namedDefinition) return { definition: namedDefinition, name }

  if (!loaded || typeof loaded !== "object") return undefined

  if ("default" in loaded && isWorkflowHandle(loaded.default)) {
    const definition = definitions.get(loaded.default.name)
    if (definition) return { definition, name: loaded.default.name }
  }

  const matches = new Map<string, WorkflowDefinition>()
  for (const value of Object.values(loaded)) {
    if (!isWorkflowHandle(value)) continue
    const definition = definitions.get(value.name)
    if (definition) matches.set(value.name, definition)
  }

  if (matches.size !== 1) return undefined
  const [matchedName, definition] = matches.entries().next().value!
  return { definition, name: matchedName }
}

export function takeInlineWorkflowDefinitionForModule(name: string, loaded: unknown): WorkflowDefinition | undefined {
  const loading = loadingInlineRegistryStorage.getStore()
  const current = !loading || loading.state === registryState
  const match = (loading && findExportedInlineWorkflowDefinition(name, loaded, loading.definitions))
    || (current ? findExportedInlineWorkflowDefinition(name, loaded, inlineRegistry) : undefined)
  if (!match) return undefined
  if (current) consumeInlineWorkflowDefinition(match.name, match.definition)
  return match.definition
}

function consumeInlineWorkflowDefinition(name: string, expected?: WorkflowDefinition): WorkflowDefinition | undefined {
  const definition = inlineRegistry.get(name)
  if (!expected || definition === expected) {
    inlineRegistry.delete(name)
  }
  return definition
}

export function registerInlineWorkflowDefinition(name: string, definition: WorkflowDefinition): void {
  if (!name || typeof name !== "string") {
    throw workflowErrorDiagnostics.WORKFLOW_R0023({ message: "`createWorkflow()` requires a workflow name." })
  }

  const loading = loadingInlineRegistryStorage.getStore()
  const loadingDefinitions = loading?.definitions
  const existing = inlineRegistry.get(name)
  if (existing && existing !== definition) {
    if (!loadingDefinitions) {
      throw workflowErrorDiagnostics.WORKFLOW_R0024({ message: `Duplicate workflow name "${name}" from inline definitions.` })
    }
  }
  if (!loading || loading.state === registryState) inlineRegistry.set(name, definition)

  loadingDefinitions?.set(name, definition)
}

export async function loadWorkflowDefinition(name: string): Promise<WorkflowDefinition | undefined> {
  const state = registryState
  const inlineDefinition = inlineRegistry.get(name)
  const entry = state.registry?.[name]

  if (entry && state.loaded.has(name)) {
    return state.loaded.get(name)
  }

  if (inlineDefinition) {
    if (entry) {
      throw workflowErrorDiagnostics.WORKFLOW_R0025({ message: `Duplicate workflow name "${name}" from inline and discovered definitions.` })
    }
    return inlineDefinition
  }

  if (!entry) {
    return undefined
  }

  const activeLoads = loadingRegistryStorage.getStore()
  const inFlightEntry = state.loading.get(name)
  if (inFlightEntry) {
    return activeLoads?.state === state && activeLoads.names.has(name) ? undefined : await inFlightEntry
  }

  const nextActiveLoads = new Set(activeLoads?.state === state ? activeLoads.names : undefined)
  nextActiveLoads.add(name)
  const loadingEntry = Promise.resolve().then(() => loadingRegistryStorage.run({ names: nextActiveLoads, state }, async () => {
    const loadingInlineDefinitions = new Map<string, WorkflowDefinition>()
    state.inlineLoads.add(loadingInlineDefinitions)
    try {
      return await loadingInlineRegistryStorage.run({ definitions: loadingInlineDefinitions, state }, async () => {
        const loaded = await entry()
        if (!loaded || typeof loaded !== "object") {
          return undefined
        }
        const registeredInlineDefinition = loadingInlineDefinitions.get(name) ?? (state === registryState ? consumeInlineWorkflowDefinition(name) : undefined)
        if (registeredInlineDefinition) {
          if (state === registryState) consumeInlineWorkflowDefinition(name, registeredInlineDefinition)
          return registeredInlineDefinition
        }
        const definition = ("default" in loaded ? loaded.default : loaded) as WorkflowDefinition | undefined
        if (definition && typeof definition.handler === "function") {
          return definition
        }
        const exportedInlineDefinition = findExportedInlineWorkflowDefinition(name, loaded, loadingInlineDefinitions)
        if (!exportedInlineDefinition) return undefined
        if (state === registryState) consumeInlineWorkflowDefinition(exportedInlineDefinition.name, exportedInlineDefinition.definition)
        return exportedInlineDefinition.definition
      })
    }
    catch (error) {
      if (state === registryState) {
        for (const [inlineName, definition] of loadingInlineDefinitions) {
          consumeInlineWorkflowDefinition(inlineName, definition)
        }
      }
      throw error
    }
    finally {
      state.inlineLoads.delete(loadingInlineDefinitions)
    }
  }))
  state.loading.set(name, loadingEntry)
  try {
    const loaded = await loadingEntry
    state.loaded.set(name, loaded)
    return loaded
  }
  finally {
    state.loading.delete(name)
  }
}

export function resetWorkflowDefinitions(): void {
  setWorkflowRuntimeRegistry(undefined)
  inlineRegistry.clear()
}
