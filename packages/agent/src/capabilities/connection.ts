import * as v from "valibot"

import { agentInvocationTraceIdContextKey } from "../trace.ts"
import { primitiveHandle } from "./internal.ts"

import type { AgentCapabilityContext, AgentToolPolicyDecision } from "../types.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"

export type AgentConnectionEffect = "read" | "write"

/** Structural view of a `@vite-hub/connections` Operation. Agents do not depend on the package. */
export interface AgentConnectionOperation<TInput> {
  effect: AgentConnectionEffect
  id: string
  request: (input: TInput) => unknown
}

interface AgentConnectionActor {
  id: string
  kind: "agent"
}

interface AgentConnectionTrace {
  invocationId?: string
  runId?: string
  tool?: string
}

interface AgentConnectionCallOptions {
  actor: AgentConnectionActor
  audit: "all" | "changes"
  effect?: AgentConnectionEffect
  event?: unknown
  operation?: string
  trace: AgentConnectionTrace
}

interface AgentConnectionActivity extends AgentConnectionTrace {
  action: "call"
  actor: AgentConnectionActor
  connection: string
  effect: AgentConnectionEffect
  operation: string
  outcome: "approval-required" | "denied"
}

/** Structural view of the Connections runtime that Agent Capabilities use. */
export interface AgentConnectionsRuntime {
  call: <TInput>(name: string, operation: AgentConnectionOperation<TInput>, input: TInput, options: AgentConnectionCallOptions) => Promise<unknown>
  decide: (name: string, actor: AgentConnectionActor, operation: { effect: AgentConnectionEffect, id: string }) => Promise<"allow" | "deny" | "require-approval">
  fetch: (name: string, url: string | URL, init: RequestInit | undefined, options: AgentConnectionCallOptions) => Promise<Response>
  record: (activity: AgentConnectionActivity, event?: unknown) => Promise<void>
}

export interface AgentConnectionsPrimitive {
  operations?: Record<string, unknown>
  runtime: () => AgentConnectionsRuntime
}

export interface AgentConnectionFetchOptions {
  audit?: "all" | "changes"
  effect?: AgentConnectionEffect
  operation: string
  tool?: string
}

/** A Connection bound to one Agent Invocation. Every call records activity for the Agent actor. */
export interface AgentConnection {
  call: <TInput>(tool: string, operation: AgentConnectionOperation<TInput>, input: TInput) => Promise<unknown>
  /** Authenticated fetch. `audit: "changes"` records only writes, denials, and failures. Default: `"all"`. */
  fetch: (request: AgentConnectionFetchOptions, url: string | URL, init?: RequestInit) => Promise<Response>
  readonly name: string
  /** Tool policy that checks every Operation before the tool runs. Denials and approvals are recorded. */
  policy: (tool: string, operations: ReadonlyArray<{ effect: AgentConnectionEffect, id: string }>) => () => Promise<AgentToolPolicyDecision>
  readonly primitive: AgentConnectionsPrimitive
}

const primitiveSchema = v.looseObject({
  operations: v.optional(v.record(v.string(), v.unknown())),
  runtime: v.custom<() => AgentConnectionsRuntime>(value => v.is(v.function(), value)),
})

export const connectionNameSchema: v.GenericSchema<unknown, string> = v.pipe(v.string(), v.trim(), v.minLength(1))

function optionalString(value: unknown): string | undefined {
  return v.is(v.string(), value) && value ? value : undefined
}

export function useAgentConnection(context: AgentCapabilityContext, name: string, capability: string): AgentConnection {
  const handle = primitiveHandle(context, "connections")
  if (!handle) {
    throw agentDiagnostics.AGENT_R0080({ message: `[vitehub] ${capability}() uses Connection "${name}", so it requires Connections. Set vitehub({ connections: true }).` })
  }
  const parsed = v.safeParse(primitiveSchema, handle)
  if (!parsed.success) {
    throw agentDiagnostics.AGENT_R0080({ message: `[vitehub] ${capability}() requires the connections primitive to expose runtime().` })
  }
  const primitive = parsed.output
  const runtime = primitive.runtime()
  const actor: AgentConnectionActor = { id: context.agentIdentity?.name ?? "agent", kind: "agent" }
  const trace = (tool: string | undefined): AgentConnectionTrace => ({
    invocationId: optionalString(context.context.get(agentInvocationTraceIdContextKey)),
    runId: optionalString(context.run?.runId),
    ...(tool ? { tool } : {}),
  })
  return {
    call: (tool, operation, input) => runtime.call(name, operation, input, { actor, audit: "all", event: context.event, trace: trace(tool) }),
    fetch: (request, url, init) => runtime.fetch(name, url, init, {
      actor,
      audit: request.audit ?? "all",
      ...(request.effect ? { effect: request.effect } : {}),
      event: context.event,
      operation: request.operation,
      trace: trace(request.tool),
    }),
    name,
    policy: (tool, operations) => async () => {
      let pending: { effect: AgentConnectionEffect, id: string } | undefined
      for (const operation of operations) {
        const decision = await runtime.decide(name, actor, operation)
        if (decision === "deny") {
          await record(runtime, context, { ...trace(tool), action: "call", actor, connection: name, effect: operation.effect, operation: operation.id, outcome: "denied" })
          return "deny"
        }
        if (decision === "require-approval") pending ??= operation
      }
      if (!pending) return "allow"
      await record(runtime, context, { ...trace(tool), action: "call", actor, connection: name, effect: pending.effect, operation: pending.id, outcome: "approval-required" })
      return "require-approval"
    },
    primitive,
  }
}

async function record(runtime: AgentConnectionsRuntime, context: AgentCapabilityContext, activity: AgentConnectionActivity): Promise<void> {
  // A missing audit store must not turn a denial into another error.
  await runtime.record(activity, context.event).catch(() => undefined)
}
