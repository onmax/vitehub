import { createAgentEnvIdentity, readAgentEnvIdentity } from "@vite-hub/runtime/internal/agent-identity"

export const agentEnvIdentity: unique symbol = Symbol("vitehub.agentEnvIdentity")

export { createAgentEnvIdentity, readAgentEnvIdentity }
