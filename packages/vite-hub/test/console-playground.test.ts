import { afterEach, expect, it, vi } from "vitest"
import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"
import type { Plugin, ViteDevServer } from "vite"

import { requestConsole } from "../src/console/runtime/client/request.ts"

// The playground is outside this package's TypeScript project, so load its real module at test time.
const { callConsoleFixture } = await vi.importActual<{
  callConsoleFixture: (origin: string, payload: unknown) => Promise<unknown>
}>("../../../playground/console/rpc.ts")

afterEach(() => {
  vi.unstubAllGlobals()
})

it("loads Console data through the playground's stateless RPC endpoint", async () => {
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "/_vitehub/rpc/__call") {
      return Response.json(await callConsoleFixture("http://localhost:5173", JSON.parse(String(init?.body))))
    }
    return Response.json({ sections: ["agents"] })
  })
  vi.stubGlobal("fetch", fetch)

  await expect(requestConsole("/api/_vitehub/console/sections"))
    .resolves.toEqual({ sections: ["agents"] })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch).toHaveBeenLastCalledWith(new URL("http://localhost:5173/api/_vitehub/console/sections"), {
    body: undefined,
    headers: { "content-type": "application/json" },
    method: "GET",
  })
})

it("rejects invalid deletion bodies in the playground without deleting the record", async () => {
  const { consoleMockAPI } = await vi.importActual<{ consoleMockAPI: () => Plugin }>("../../../playground/console/mock-api.ts")
  const use = vi.fn<(handler: (request: IncomingMessage, response: ServerResponse, next: () => void) => Promise<void>) => void>()
  const configure = consoleMockAPI().configureServer
  if (typeof configure !== "function") throw new Error("Missing playground server hook")
  // SAFETY: The playground hook only registers middleware on this server fixture.
  configure.call({} as ThisParameterType<typeof configure>, { middlewares: { use } } as unknown as ViteDevServer)
  const handler = use.mock.calls[0]![0]
  const request = async (method: string, body?: string) => {
    const input = new IncomingMessage(new Socket())
    input.method = method
    input.url = "/api/_vitehub/console/invocations/ainv_capabilities_mcp_title"
    input.push(body ?? "")
    input.push(null)
    const response = new ServerResponse(input)
    const end = vi.spyOn(response, "end").mockReturnValue(response)
    await handler(input, response, vi.fn())
    return { status: response.statusCode, body: JSON.parse(String(end.mock.calls[0]?.[0])) }
  }
  for (const body of ["{", "null", "[]", "{}", '{"action":"cancel"}', '{"action":"delete","extra":true}']) {
    expect((await request("POST", body)).status).toBe(400)
    expect((await request("GET")).status).toBe(200)
  }
  expect(await request("POST", '{"action":"delete"}')).toEqual({
    status: 200,
    body: { id: "ainv_capabilities_mcp_title", outcome: "deleted" },
  })
  expect((await request("GET")).status).toBe(404)
})
