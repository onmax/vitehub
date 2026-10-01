import { AsyncLocalStorage } from "node:async_hooks"
import * as v from "valibot"

import { defineMcpToolCapability, sanitizeMcpMetadata } from "../internal/mcp-tool-capability.ts"
import { connectionNameSchema, useAgentConnection } from "./connection.ts"

import type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentRuntimeConfig,
} from "../types.ts"
import type { McpToolServerConnection } from "../internal/mcp-tool-capability.ts"
import type { AgentConnectionFetchOptions } from "./connection.ts"
import type { McpCapabilityOptions, McpClient, McpClientConfig } from "../mcp/types.ts"
import type { WorkspaceName } from "@vite-hub/workspace"
import { agentDiagnostics } from "../agent-diagnostics.ts"

function normalizeMcpToolName(serverName: string, toolName: string) {
  return `mcp_${serverName}_${toolName}`.replace(/[^a-zA-Z0-9_]/g, "_")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMcpClientConfig(value: McpClient | McpClientConfig): value is McpClientConfig {
  return "transport" in value
    && !("tools" in value && typeof value.tools === "function"
      && "close" in value && typeof value.close === "function")
}

function withMcpInitializationCompatibility(connection: McpClient | McpClientConfig): McpClient | McpClientConfig {
  if (!isMcpClientConfig(connection)) return connection
  return {
    ...connection,
    protocolVersionDiscovery: connection.protocolVersionDiscovery ?? false,
  }
}

type McpHttpTransportConfig = Extract<McpClientConfig["transport"], { url: string }>

function isHttpTransportConfig(transport: McpClientConfig["transport"]): transport is McpHttpTransportConfig {
  return "type" in transport && (transport.type === "http" || transport.type === "sse") && "url" in transport
}

/** A static server config that names a Connection. A resolver can also return `connection`; `useAgentConnection()` checks the primitive when it runs. */
const connectionConfigSchema = v.looseObject({ connection: v.string(), transport: v.looseObject({}) })

const jsonRpcRequestSchema = v.object({
  method: v.string(),
  params: v.optional(v.looseObject({ arguments: v.optional(v.unknown()), name: v.optional(v.string()) })),
})

function parseJsonBody(body: RequestInit["body"]): unknown {
  if (!v.is(v.string(), body)) return undefined
  try {
    return JSON.parse(body)
  }
  catch {
    return undefined
  }
}

/**
 * Maps one transport request to a Connection Operation.
 * Tool calls are writes under `mcp.<server>.tools.<tool>` and every call is recorded.
 * Protocol messages are reads under `mcp.<server>.rpc.<method>`. Only denials and failures are recorded.
 */
export function mcpConnectionRequest(server: string, init: RequestInit | undefined): AgentConnectionFetchOptions {
  const method = (init?.method ?? "GET").toUpperCase()
  const message = method === "POST" ? v.safeParse(jsonRpcRequestSchema, parseJsonBody(init?.body)) : undefined
  const tool = message?.success && message.output.method === "tools/call" ? message.output.params?.name : undefined
  if (tool) return { effect: "write", operation: mcpToolOperation(server, tool).id, tool: normalizeMcpToolName(server, tool) }
  const rpc = message?.success ? message.output.method : method === "POST" ? "message" : "stream"
  return { audit: "changes", effect: "read", operation: `mcp.${server}.rpc.${rpc}` }
}

function mcpToolOperation(server: string, tool: string): { effect: "write", id: string } {
  // MCP tool annotations come from the server, so the Connection treats every tool call as a write.
  return { effect: "write", id: `mcp.${server}.tools.${tool}` }
}

function withMcpConnection(context: AgentCapabilityContext, server: string, config: McpClientConfig): { binding: McpToolServerConnection, config: McpClientConfig } {
  const { connection: rawName, ...rest } = config
  const name = v.safeParse(connectionNameSchema, rawName)
  if (!name.success) {
    throw agentDiagnostics.AGENT_R0083({ message: `[vitehub] mcp({ servers }) server "${server}" requires a non-empty connection name.` })
  }
  const transport = rest.transport
  if (!isHttpTransportConfig(transport) || transport.authProvider) {
    throw agentDiagnostics.AGENT_R0082({ message: `[vitehub] mcp({ servers }) server "${server}" uses a connection, so it requires an http or sse transport config without authProvider.` })
  }
  const connection = useAgentConnection(context, name.output, "mcp")
  // Each async tool execution owns its grant, even when concurrent calls have identical arguments.
  const approvals = new AsyncLocalStorage<{ arguments: string, operation: string, used: boolean } | undefined>()
  const request = (init: RequestInit | undefined): AgentConnectionFetchOptions => {
    const options = mcpConnectionRequest(server, init)
    const grant = approvals.getStore()
    const message = v.safeParse(jsonRpcRequestSchema, parseJsonBody(init?.body))
    if (!options.tool || !grant || grant.used || grant.operation !== options.operation
      || !message.success || grant.arguments !== JSON.stringify(message.output.params?.arguments ?? {})) return options
    grant.used = true
    return { ...options, approved: true }
  }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (!(input instanceof Request)) return connection.fetch(request(init), input, init)
    // A Request carries its own method, headers, body, and signal. `init` overrides them, as in `new Request(input, init)`.
    const target = new Request(input, init)
    const body = target.method === "GET" || target.method === "HEAD" ? undefined : await target.text()
    const merged: RequestInit = { body, headers: target.headers, method: target.method, signal: target.signal }
    return connection.fetch(request(merged), target.url, merged)
  }
  return {
    binding: {
      execute: async (operation, input, approved, run) => {
        const grant = approved ? { arguments: JSON.stringify(input ?? {}), operation, used: false } : undefined
        try {
          return await approvals.run(grant, run)
        }
        finally {
          if (grant) grant.used = true
        }
      },
      connection,
      operation: tool => mcpToolOperation(server, tool),
    },
    config: { ...rest, transport: { ...transport, fetch } },
  }
}

function assertMcpIntegrityOptions(options: McpCapabilityOptions) {
  if (options.integrity === undefined) return
  if (!isRecord(options.integrity)) {
    throw agentDiagnostics.AGENT_R0114({ message: "[vitehub] mcp({ integrity }) requires fingerprint maps keyed by configured server name." })
  }
  for (const [server, fingerprints] of Object.entries(options.integrity)) {
    if (!Object.hasOwn(options.servers, server)) {
      throw agentDiagnostics.AGENT_R0115({ message: `[vitehub] mcp({ integrity }) references unknown server "${server}".` })
    }
    if (!isRecord(fingerprints) || Object.values(fingerprints).some(value => typeof value !== "string")) {
      throw agentDiagnostics.AGENT_R0116({ message: `[vitehub] mcp({ integrity }) requires a tool fingerprint map for server "${server}".` })
    }
  }
}

export function mcp<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(options: McpCapabilityOptions<TRuntimeConfig, Name>): AgentCapabilityDefinition<TRuntimeConfig, Name> {
  if (!options || typeof options !== "object" || !options.servers || typeof options.servers !== "object") {
    throw agentDiagnostics.AGENT_R0117({ message: "[vitehub] mcp({ servers }) requires a server map." })
  }
  assertMcpIntegrityOptions(options)
  const usesConnections = Object.values(options.servers).some(server => v.is(connectionConfigSchema, server))
  return defineMcpToolCapability({
    degradeUnavailable: true,
    id: "mcp",
    inspection: {
      label: "MCP",
      view: {
        root: "root",
        elements: {
          root: { type: "Stack", props: {}, children: ["empty", "servers"] },
          empty: { type: "Text", props: { text: { $state: "/empty" } } },
          servers: { type: "Stack", props: {}, repeat: { statePath: "/servers", key: "name" }, children: ["server"] },
          server: {
            type: "Section",
            props: { title: { $item: "/name" } },
            children: ["status", "connection", "tools"],
          },
          status: { type: "KeyValue", props: { label: "Discovery", value: { $item: "/status" } } },
          connection: { type: "KeyValue", props: { label: "Connection", value: { $item: "/connection" } } },
          tools: { type: "Tools", props: { mcpServer: { $item: "/name" } } },
        },
      },
    },
    integrityLabel: "mcp({ integrity })",
    invalidServerMessage: "[vitehub] mcp({ servers }) entries must resolve to an MCP client or MCP client config.",
    metadata: { servers: sanitizeMcpMetadata(options.servers) as Record<string, unknown> },
    ...(usesConnections ? { requires: [{ primitive: "connections" }] } : {}),
    servers: Object.entries(options.servers).map(([name, server]) => ({
      name,
      async resolve(context) {
        const owned = typeof server === "function"
        const connection = owned ? await server(context) : server
        if (connection === false || connection === null || connection === undefined) return
        const bound = isMcpClientConfig(connection) && connection.connection !== undefined
          ? withMcpConnection(context, name, connection)
          : undefined
        return {
          connection: withMcpInitializationCompatibility(bound?.config ?? connection),
          ...(bound ? { connectionBinding: bound.binding } : {}),
          integrity: options.integrity && Object.hasOwn(options.integrity, name)
            ? options.integrity[name]
            : undefined,
          owned,
        }
      },
    })),
    toolName: normalizeMcpToolName,
  })
}

export type {
  McpCapabilityOptions,
  McpClient,
  McpClientConfig,
  McpServerConfig,
  McpToolFingerprints,
} from "../mcp/types.ts"
