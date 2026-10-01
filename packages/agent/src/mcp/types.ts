import type {
  AgentCapabilityRuntimeContext,
  AgentRuntimeConfig,
  MaybePromise,
} from "../types.ts"
import type { WorkspaceName } from "@vite-hub/workspace"
import type { MCPClientConfig as AiSdkMcpClientConfig } from "@ai-sdk/mcp"

export interface McpClient {
  close: () => MaybePromise<void>
  serverInfo?: unknown
  tools: () => MaybePromise<Record<string, unknown>>
}

export interface McpClientConfig extends AiSdkMcpClientConfig {
  /**
   * Name of a Connection in `server/connections/`. The Connection sends the `Authorization` header,
   * checks access for each request, and records activity. It replaces `transport.fetch`.
   * Requires an `http` or `sse` transport config without `authProvider`.
   */
  connection?: string
  initializationOptions?: {
    signal?: AbortSignal
    timeout?: number
  }
  protocolVersionDiscovery?: boolean
}

export type McpServerConfig<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> =
  | McpClient
  | McpClientConfig
  | false
  | null
  | undefined
  | ((context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<McpClient | McpClientConfig | false | null | undefined>)

export type McpToolFingerprints = Record<string, string>

export interface McpCapabilityOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  integrity?: Record<string, McpToolFingerprints>
  servers: Record<string, McpServerConfig<TRuntimeConfig, Name>>
}
