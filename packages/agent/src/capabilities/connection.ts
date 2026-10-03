import * as v from "valibot"

import { agentInvocationTraceIdContextKey } from "../trace.ts"
import { primitiveHandle } from "./internal.ts"

import type { AgentCapabilityContext } from "../types.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"

export const connectionNameSchema: v.GenericSchema<unknown, string> = v.pipe(v.string(), v.trim(), v.minLength(1))

/** Structural view of the governed client that Connections exposes to server code. */
export interface AgentConnectionClient {
  call: (action: string, input?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
  fetch: (input: string | URL, init?: Pick<RequestInit, "headers" | "method" | "redirect" | "signal"> & { body?: string }) => Promise<Response>
}

interface AgentConnectionClientOptions {
  actor: string
  invocationId?: string
}

export function useAgentConnectionClient(context: AgentCapabilityContext, name: string, capability: string): AgentConnectionClient {
  const handle = primitiveHandle(context, "connections")
  if (!handle) {
    throw agentDiagnostics.AGENT_R0080({ message: `[vitehub] ${capability}() uses Connection "${name}", so it requires Connections. Set vitehub({ connections: true }).` })
  }
  const primitive = v.safeParse(v.object({ runtime: v.function() }), handle)
  if (!primitive.success) {
    throw agentDiagnostics.AGENT_R0080({ message: `[vitehub] ${capability}() requires the connections primitive to expose runtime().` })
  }
  const runtime = v.safeParse(v.object({ client: v.function() }), primitive.output.runtime())
  if (!runtime.success) {
    throw agentDiagnostics.AGENT_R0080({ message: `[vitehub] ${capability}() requires the Connections runtime to expose client().` })
  }
  const invocationId = optionalString(context.context.get(agentInvocationTraceIdContextKey))
  const clientOptions: AgentConnectionClientOptions = {
    actor: `agent:${context.agentIdentity?.name ?? "agent"}`,
    ...(invocationId ? { invocationId } : {}),
  }
  const client: unknown = runtime.output.client(name, clientOptions)
  const parsed = v.safeParse(v.object({ call: v.function(), fetch: v.function() }), client)
  if (!parsed.success) {
    throw agentDiagnostics.AGENT_R0080({ message: `[vitehub] ${capability}() requires a Connections client with call() and fetch().` })
  }
  // SAFETY: The structural schema checks the runtime client. Its methods match the Connections public contract.
  return parsed.output as AgentConnectionClient
}

function optionalString(value: unknown): string | undefined {
  return v.is(v.string(), value) && value ? value : undefined
}
