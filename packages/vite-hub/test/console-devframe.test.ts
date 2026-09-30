import { createRpcClient } from "devframe/rpc/client"
import { createSseRpcChannel } from "devframe/rpc/transports/sse-client"
import { describe, expect, it, vi } from "vitest"

import { requestConsole } from "../src/console/runtime/client/request.ts"
import { createConsoleDevframeHandler } from "../src/console/runtime/server/devframe.ts"
import { consoleRpcHeader, consoleRpcMethods } from "../src/console/runtime/rpc.ts"
import { installConsoleProjectName, installConsoleSections } from "../src/console/runtime/server/sections.ts"

import type { ConsoleRpcFunctions } from "../src/console/runtime/rpc.ts"

describe("Console Devframe", () => {
  it.each([
    "/_vitehub/rpc/__sse",
    "/_vitehub/rpc/__sse/",
    "/_vitehub/rpc/__sse/child",
    "/_vitehub/rpc/__sse/__connection.json",
    "/_vitehub/rpc/__%73se",
    "/tools/_vitehub/rpc/__sse",
  ])("rejects headerless HTTP session requests to %s", async (path) => {
    const handler = createConsoleDevframeHandler()
    try {
      const request = new Request(`http://vitehub.local${path}`)
      // SAFETY: This fixture supplies the request fields read by the ViteHub H3 adapter.
      const response = await handler({ method: request.method, req: request } as never) as Response
      try {
        expect(response.status).toBe(403)
        expect(response.headers.has("access-control-allow-origin")).toBe(false)
      } finally {
        await response.body?.cancel()
      }
    } finally {
      await handler.close()
    }
  })

  it.each([
    { origin: "https://untrusted.example" },
    { origin: "https://untrusted.example", "sec-fetch-site": "cross-site", [consoleRpcHeader]: "1" },
    { origin: "null" },
    { origin: "null", "sec-fetch-site": "same-origin" },
    { origin: "null", [consoleRpcHeader]: "1" },
    { origin: "http://vitehub.local:8080" },
    { origin: "https://untrusted.example", "sec-fetch-site": "none" },
    { origin: "https://untrusted.example", "sec-fetch-site": "none", [consoleRpcHeader]: "1" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { "sec-fetch-site": "none" },
    { [consoleRpcHeader]: "0" },
    {
      origin: "https://untrusted.example",
      "access-control-request-method": "GET",
      "access-control-request-headers": consoleRpcHeader,
    },
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

  it("rejects a foreign preflight even if it includes the marker", async () => {
    const handler = createConsoleDevframeHandler()
    try {
      const request = new Request("http://vitehub.local/_vitehub/rpc/__sse", {
        headers: { origin: "https://untrusted.example", [consoleRpcHeader]: "1", "access-control-request-method": "POST", "access-control-request-headers": consoleRpcHeader },
        method: "OPTIONS",
      })
      const response = await handler({ method: request.method, req: request } as never) as Response
      expect(response.status).toBe(403)
      expect(response.headers.has("access-control-allow-origin")).toBe(false)
      await response.body?.cancel()
    } finally {
      await handler.close()
    }
  })

  it.each([
    { origin: "https://vitehub.local" },
    { "sec-fetch-site": "same-origin" },
    { [consoleRpcHeader]: "1" },
  ])("accepts same-origin evidence or the marker under a mounted Console path: %j", async (headers) => {
    const handler = createConsoleDevframeHandler()
    try {
      const request = new Request("https://vitehub.local/tools/_vitehub/rpc/__sse", {
        headers,
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

  it.each(["", "/tools"])("allows headerless connection discovery under '%s'", async (base) => {
    const handler = createConsoleDevframeHandler()
    try {
      const request = new Request(`http://vitehub.local${base}/_vitehub/rpc/__connection.json`)
      // SAFETY: This fixture supplies the request fields read by the ViteHub H3 adapter.
      const response = await handler({ method: request.method, req: request } as never) as Response
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ backend: "sse", sse: { path: "__sse" } })
    } finally {
      await handler.close()
    }
  })

  it.each([
    { origin: "https://vitehub.local", "sec-fetch-site": "same-origin" },
    { origin: "https://vitehub.local", [consoleRpcHeader]: "1" },
  ])("accepts browser same-origin metadata or the marker behind TLS termination: %j", async (headers) => {
    const handler = createConsoleDevframeHandler()
    try {
      const request = new Request("http://vitehub.local/_vitehub/rpc/__sse", {
        headers,
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
      request.headers.set(consoleRpcHeader, "1")
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

  it.each([false, true])("connects the built-in client with headerless discovery and marked SSE requests behind TLS termination: %s", async (tlsTermination) => {
    installConsoleSections("/console-client-transport-test", ["agents"])
    installConsoleProjectName("/console-client-transport-test", "Console client")
    const handler = createConsoleDevframeHandler()
    const requests: Request[] = []
    const appBase = tlsTermination ? "/proxy-client" : "/client"
    vi.stubGlobal("location", new URL(`http://vitehub.local${appBase}/_vitehub`))
    vi.stubGlobal("__DEVFRAME_CONNECTION__", undefined)
    vi.stubGlobal("__DEVFRAME_CONNECTION_META__", undefined)
    const fetchThroughNitroHandler: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(new URL(input, "http://vitehub.local"), init)
      if (tlsTermination && new URL(request.url).pathname.endsWith("/__sse")) {
        request.headers.set("origin", "https://vitehub.local")
      }
      requests.push(request)
      // SAFETY: This fixture supplies the request fields read by the ViteHub H3 adapter.
      return await handler({ method: request.method, req: request } as never) as Response
    }
    vi.stubGlobal("fetch", fetchThroughNitroHandler)
    try {
      await expect(requestConsole(`${appBase}/api/_vitehub/console/sections`))
        .resolves.toEqual({ projectName: "Console client", sections: ["agents"] })
      const discovery = requests.find((request) => new URL(request.url).pathname.endsWith("/__connection.json"))
      expect(discovery?.headers.has(consoleRpcHeader)).toBe(false)
      const transport = requests.filter((request) => new URL(request.url).pathname.endsWith("/__sse"))
      expect(new Set(transport.map((request) => request.method))).toEqual(new Set(["GET", "POST"]))
      for (const request of transport) {
        expect(request.headers.get(consoleRpcHeader)).toBe("1")
        expect(request.headers.get("origin")).toBe(tlsTermination ? "https://vitehub.local" : null)
        expect(request.headers.has("sec-fetch-site")).toBe(false)
      }
    } finally {
      await handler.close()
      vi.unstubAllGlobals()
    }
  })

  it("returns operation errors through their RPC method", async () => {
    const handler = createConsoleDevframeHandler()
    const channel = createSseRpcChannel({
      fetch: async (input, init) => {
        const request = new Request(input, init)
        request.headers.set(consoleRpcHeader, "1")
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
