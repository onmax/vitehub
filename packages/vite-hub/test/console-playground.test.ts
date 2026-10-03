import { afterEach, expect, it, vi } from "vitest"
import { Readable } from "node:stream"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Plugin } from "vite"

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

async function playgroundRequest(endpoint: string, input?: unknown, status = 200): Promise<unknown> {
  const { consoleMockAPI } = await vi.importActual<{ consoleMockAPI: () => Plugin }>("../../../playground/console/mock-api.ts")
  type Middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => Promise<void>
  let handler: Middleware | undefined
  // SAFETY: The playground hook only registers middleware with this server fixture.
  const configure = consoleMockAPI().configureServer as (server: { middlewares: { use: (middleware: Middleware) => void } }) => void
  configure({ middlewares: { use: middleware => { handler = middleware } } })
  // SAFETY: The route reads only the method, URL, and body stream from this fixture.
  const request = Readable.from(input === undefined ? [] : [JSON.stringify(input)]) as IncomingMessage
  request.method = input === undefined ? "GET" : "POST"
  request.url = endpoint
  let text = ""
  const response = { statusCode: 200, setHeader: vi.fn(), end: (value: string) => { text = value } }
  if (!handler) throw new Error("Expected playground middleware")
  // SAFETY: The route writes only the status, headers, and response body.
  await handler(request, response as unknown as ServerResponse, () => { throw new Error("Unexpected next middleware") })
  expect(response.statusCode).toBe(status)
  return JSON.parse(text)
}

it("paginates Blob fixtures when the Console omits a limit", async () => {
  const first = await playgroundRequest("/api/_vitehub/console/blob")
  expect(first).toMatchObject({ hasMore: true, cursor: "3", limit: 3, blobs: expect.any(Array) })
  expect(first).toHaveProperty("blobs.length", 3)
  const next = await playgroundRequest("/api/_vitehub/console/blob?cursor=3")
  expect(next).toMatchObject({ hasMore: false, blobs: [
    expect.objectContaining({ pathname: "exports/usage-september.csv" }),
    expect.objectContaining({ pathname: "invoices/inv_2026_09.pdf" }),
  ] })
  expect(next).not.toHaveProperty("cursor")
  const filtered = await playgroundRequest("/api/_vitehub/console/blob?prefix=screenshots/")
  expect(filtered).toMatchObject({ hasMore: false })
  expect(filtered).toHaveProperty("blobs.length", 2)
})

it("returns succeeded Schedule runs and consistent run history", async () => {
  await expect(playgroundRequest("/api/_vitehub/console/schedule-run", { name: "nightly-digest" }))
    .resolves.toMatchObject({ run: { scheduleId: "nightly-digest", status: "succeeded" } })
  const history = await playgroundRequest("/api/_vitehub/console/definitions?section=schedules")
  expect(history).toMatchObject({ records: expect.arrayContaining([
    expect.objectContaining({
      id: "runtime:sched_console_reindex",
      cells: expect.objectContaining({ lastRun: expect.stringContaining("succeeded at") }),
      fields: expect.arrayContaining([
        { label: "Run 1", value: expect.stringContaining(", succeeded,") },
        { label: "Run 2", value: expect.stringContaining(", failed,") },
        { label: "Run 3", value: expect.stringContaining(", succeeded,") },
      ]),
    }),
  ]) })
})

it.each(["reindex-console", "sched_console_reindex", "unknown-schedule"])("rejects non-runnable Schedule %j", async (name) => {
  await expect(playgroundRequest("/api/_vitehub/console/schedule-run", { name }, 404))
    .resolves.toEqual({ message: "Schedule run is not available. Set manual: true on the Schedule Definition and enable Console invocation." })
})

it.each([null, {}, { name: "" }, { name: 42 }])("rejects invalid Schedule payload %j", async (input) => {
  await expect(playgroundRequest("/api/_vitehub/console/schedule-run", input, 400))
    .resolves.toEqual({ message: "Schedule run requires a Schedule Definition name." })
})

it.each(["", "Inspect this screenshot"])("preserves images in a new chat with prompt %j", async (prompt) => {
  const file = { url: "data:image/png;base64,aW1hZ2U=", filename: "screenshot.png" }
  const created = await playgroundRequest("/api/_vitehub/console/agents/interface-engineer/invocations", { prompt, files: [file] })
  expect(created).toMatchObject({ id: expect.any(String) })
  // SAFETY: The assertion above verifies the response ID before it is used in a route.
  const { id } = created as { id: string }
  const detail = await playgroundRequest(`/api/_vitehub/console/invocations/${id}`)
  expect(detail).toMatchObject({
    invocation: { status: "running", title: prompt || file.filename },
    observations: expect.arrayContaining([expect.objectContaining({
      name: "agent.invocation.start",
      attributes: expect.objectContaining({
        "input.hasPrompt": Boolean(prompt),
        "input.hasMessages": true,
        "input.messages": [{ id: "user-1", role: "user", parts: [
          ...(prompt ? [{ type: "text", text: prompt }] : []),
          { type: "image", url: file.url, name: file.filename, mediaType: "image/png", size: 5 },
        ] }],
      }),
    })]),
  })
})

it("rejects empty and malformed image chats", async () => {
  const endpoint = "/api/_vitehub/console/agents/interface-engineer/invocations"
  await expect(playgroundRequest(endpoint, { prompt: "  ", files: [] }, 400))
    .resolves.toMatchObject({ error: "A prompt or image is required." })
  await expect(playgroundRequest(endpoint, { files: [{ url: "not-an-image" }] }, 400))
    .resolves.toMatchObject({ error: expect.any(String) })
})
