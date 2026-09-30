import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"

import { callMcpTool } from "../src/mcp.ts"

type ToolCallResult = Record<string, unknown>

async function startMcpServer(response: "json" | "sse", result: ToolCallResult) {
  const calls: Array<{ arguments?: unknown, authorization?: string, name?: unknown }> = []
  const server = createServer(async (request, reply) => {
    if (request.method !== "POST") {
      reply.writeHead(405).end()
      return
    }
    let body = ""
    for await (const chunk of request) body += chunk
    const message = JSON.parse(body) as { id?: number, method: string, params?: Record<string, unknown> }
    if (message.id === undefined) {
      reply.writeHead(202).end()
      return
    }
    let payload: unknown
    if (message.method === "initialize") {
      payload = {
        capabilities: { tools: {} },
        protocolVersion: message.params?.protocolVersion,
        serverInfo: { name: "test", version: "1.0.0" },
      }
    }
    else if (message.method === "tools/call") {
      calls.push({ arguments: message.params?.arguments, authorization: request.headers.authorization, name: message.params?.name })
      payload = result
    }
    else {
      reply.writeHead(200, { "content-type": "application/json" })
      reply.end(JSON.stringify({ error: { code: -32601, message: "Method not found" }, id: message.id, jsonrpc: "2.0" }))
      return
    }
    const json = JSON.stringify({ id: message.id, jsonrpc: "2.0", result: payload })
    if (response === "sse") {
      reply.writeHead(200, { "content-type": "text/event-stream" })
      reply.end(`event: message\ndata: ${json}\n\n`)
      return
    }
    reply.writeHead(200, { "content-type": "application/json" })
    reply.end(json)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  const { port } = server.address() as AddressInfo
  return { calls, url: `http://127.0.0.1:${port}/mcp` }
}

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

describe("callMcpTool", () => {
  it.each(["json", "sse"] as const)("calls a Streamable HTTP tool that answers with %s", async (response) => {
    const thread = { id: "thread-1", title: "Forecast export" }
    const { calls, url } = await startMcpServer(response, { content: [{ text: JSON.stringify({ thread }), type: "text" }] })
    const productlane = () => ({ transport: { headers: { Authorization: "Bearer token" }, type: "http" as const, url } })

    const [error, value] = await callMcpTool(productlane, "threads_get", { id: "thread-1" })

    expect(error).toBeNull()
    expect(value).toEqual({ thread })
    expect(calls).toEqual([{ arguments: { id: "thread-1" }, authorization: "Bearer token", name: "threads_get" }])
  })

  it("returns structured content before text content", async () => {
    const { url } = await startMcpServer("json", {
      content: [{ text: "Thread thread-1", type: "text" }],
      structuredContent: { id: "thread-1" },
    })

    await expect(callMcpTool({ transport: { type: "http", url } }, "threads_get")).resolves.toEqual([null, { id: "thread-1" }])
  })

  it("returns plain text content that is not JSON", async () => {
    const { url } = await startMcpServer("sse", { content: [{ text: "No thread found.", type: "text" }] })

    await expect(callMcpTool({ transport: { type: "http", url } }, "threads_get")).resolves.toEqual([null, "No thread found."])
  })

  it("returns tool errors and unreachable servers as error tuples", async () => {
    const { url } = await startMcpServer("json", { content: [{ text: "Unknown thread", type: "text" }], isError: true })

    const [toolError, toolValue] = await callMcpTool({ transport: { type: "http", url } }, "threads_get")
    expect(toolValue).toBeNull()
    expect(toolError).toMatchObject({ code: "MCP_TOOL_CALL_FAILED", message: "[vitehub] MCP tool \"threads_get\" failed: Unknown thread" })

    const [connectionError, connectionValue] = await callMcpTool({ transport: { type: "http", url: "http://127.0.0.1:9/mcp" } }, "threads_get")
    expect(connectionValue).toBeNull()
    expect(connectionError).toBeInstanceOf(Error)
  })

  it("closes clients from server functions and keeps borrowed clients open", async () => {
    const execute = vi.fn(async () => ({ content: [{ text: "{\"ok\":true}", type: "text" }] }))
    const client = { close: vi.fn(async () => undefined), tools: vi.fn(async () => ({ lookup: { execute } })) }

    await expect(callMcpTool(client, "lookup", { query: "x" })).resolves.toEqual([null, { ok: true }])
    expect(client.close).not.toHaveBeenCalled()
    await expect(callMcpTool(() => client, "lookup")).resolves.toEqual([null, { ok: true }])
    expect(client.close).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith({ query: "x" }, expect.objectContaining({ toolCallId: expect.any(String) }))

    const [missing] = await callMcpTool(client, "missing")
    expect(missing).toMatchObject({ code: "MCP_TOOL_NOT_FOUND" })
  })
})
