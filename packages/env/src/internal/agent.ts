import { grantEnvAccess, type EnvAttribution } from "./access.ts";
import type { EnvAccessContext } from "../bridge.ts";

/**
 * Internal to `@vite-hub/agent`. Call it only where the Agent Definition that runs is resolved, with that
 * Definition's identity. Never pass a name from a caller. The context names `agent:<name>` and gets only
 * the durable grants of that Agent.
 */
export function agentEnvAccess(agent: { readonly name: string }, attribution: EnvAttribution = {}): EnvAccessContext {
  return grantEnvAccess(
    { actor: { kind: "agent", id: agent.name }, traceId: attribution.traceId, invocationId: attribution.invocationId },
    { kind: "actor" },
  );
}
