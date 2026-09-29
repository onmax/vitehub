import { gmailOperations } from "./providers/gmail.ts"
import { useConnectionsRuntime } from "./runtime/state.ts"

import type { ConnectionsRuntime } from "./runtime/core.ts"

/** Handle that Agent Capabilities receive as the `connections` primitive. */
export interface ConnectionsAgentPrimitive {
  /** Typed provider Operations that official Agent Capabilities call. */
  operations: { gmail: typeof gmailOperations }
  runtime: () => ConnectionsRuntime
}

export const connections: ConnectionsAgentPrimitive = {
  operations: { gmail: gmailOperations },
  runtime: useConnectionsRuntime,
}
