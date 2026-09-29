import { createRpcClient } from "devframe/rpc/client"
import { createSseRpcChannel } from "devframe/rpc/transports/sse-client"
import { describe, expect, it } from "vitest"

import { createConsoleDevframeHandler } from "../src/console/runtime/server/devframe.ts"
import { consoleRpcMethods } from "../src/console/runtime/rpc.ts"
import { installConsoleProjectName, installConsoleSections } from "../src/console/runtime/server/sections.ts"

import type { ConsoleRpcFunctions } from "../src/console/runtime/rpc.ts"

describe("Console Devframe", () => {
  it.each([
    { origin: "https://untrusted.example" },
    { origin: "null" },
    { origin: "null", "sec-fetch-site": "same-origin" },
    { origin: "http://vitehub.local:8080" },
    { origin: "https://untrusted.example", "sec-fetch-site": "none" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ])("rejects foreign browser requests before opening an RPC session: %j", async (headers) => {
    const handler = createConsoleDevframeHandler()
    try {
      for (const method of ["GET", "POST", "OPTIONS"]) {
        const request = new Request("http://vitehub.local/_vitehub/rpc/__sse", { headers, method })
        // SAFETY: This fixture supplies the request fields read by the ViteHub H3 adapter.
        const response = await handler({ method, req: request } as never) as Response
        try {
          expect(response.status).toBe(403)
          expect(response.headers.has("access-control-allow-origin")).toBe(false)
        } finally {
          await response.body?.cancel()
        }
      }
    } finally {
      await handler.close()
    }
  })

  it("accepts the request origin under a mounted Console path", async () => {
    const handler = createConsoleDevframeHandler()
    try {
      const request = new Request("https://vitehub.local/tools/_vitehub/rpc/__sse", {
        headers: { origin: "https://vitehub.local", "sec-fetch-site": "same-origin" },
      })
      // SAFETY: This fixture supplies the request fields read by the ViteHub H3 adapter.
      const response = await handler({ method: request.method, req: request } as never) as Response
      try {
        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toBe("text/event-stream")
      } finally {
        await response.body?.cancel()
      }
    } finally {
      await handler.close()
    }
  })

  it("accepts browser same-origin metadata behind TLS termination", async () => {
    const handler = createConsoleDevframeHandler()
    try {
      const request = new Request("http://vitehub.local/_vitehub/rpc/__sse", {
        headers: { origin: "https://vitehub.local", "sec-fetch-site": "same-origin" },
      })
      // SAFETY: This fixture supplies the request fields read by the ViteHub H3 adapter.
      const response = await handler({ method: request.method, req: request } as never) as Response
      try {
        expect(response.status).toBe(200)
      } finally {
        await response.body?.cancel()
      }
    } finally {
      await handler.close()
    }
  })

  it("carries Console reads over an SSE-only RPC instance and closes cleanly", async () => {
    installConsoleSections("/console-devframe-test", ["agents", "usage"])
    installConsoleProjectName("/console-devframe-test", "SSE Console")
    const handler = createConsoleDevframeHandler()
    const fetchThroughNitroHandler: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      // SAFETY: This fixture supplies the request fields read by the ViteHub H3 adapter.
      return (await handler({
        method: request.method,
        req: request,
      } as never)) as Response
    }
    const channel = createSseRpcChannel({
      fetch: fetchThroughNitroHandler,
      url: "http://vitehub.local/_vitehub/rpc/__sse",
    })
    const client = createRpcClient<ConsoleRpcFunctions>({}, { channel })

    try {
      const connection = await fetchThroughNitroHandler("http://vitehub.local/_vitehub/rpc/__connection.json")
      await expect(connection.json()).resolves.toMatchObject({
        backend: "sse",
        sse: { path: "__sse" },
      })
      const result = await client.$call(consoleRpcMethods.sections, {})

      expect(result).toEqual({
        ok: true,
        value: { projectName: "SSE Console", sections: ["agents", "usage"] },
      })
    } finally {
      channel.close()
      await handler.close()
    }
  })

  it("returns operation errors through their RPC method", async () => {
    const handler = createConsoleDevframeHandler()
    const channel = createSseRpcChannel({
      fetch: async (input, init) => {
        const request = new Request(input, init)
        // SAFETY: This fixture supplies the request fields read by the ViteHub H3 adapter.
        return (await handler({
          method: request.method,
          req: request,
        } as never)) as Response
      },
      url: "http://vitehub.local/_vitehub/rpc/__sse",
    })
    const client = createRpcClient<ConsoleRpcFunctions>({}, { channel })

    try {
      const result = await client.$call(consoleRpcMethods.definitions, {})

      expect(result).toEqual({
        message: "A valid definition section is required.",
        ok: false,
        status: 400,
      })
    } finally {
      channel.close()
      await handler.close()
    }
  })
})
