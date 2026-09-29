import { describe, expect, it, vi } from "vitest"

import { validateAgentCapabilityComposition } from "../src/capability-runtime.ts"
import { gmail } from "../src/capabilities.ts"
import { createAgentInspectionMetadata, defineAgent } from "../src/index.ts"
import { agentInvocationTraceIdContextKey } from "../src/trace.ts"

import type { AgentCapabilityDefinition, AgentToolDefinition } from "../src/types.ts"

type Decision = "allow" | "deny" | "require-approval"
interface Operation { effect: "read" | "write", id: string, request: () => unknown }

function operation(id: string, effect: "read" | "write"): Operation {
  return { effect, id, request: () => ({}) }
}

function base64Url(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function decodeBase64Url(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))
  return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)))
}

function connections(options: { decisions?: Record<string, Decision>, record?: () => Promise<void>, responses?: Record<string, (input: Record<string, unknown>) => unknown> } = {}) {
  const runtime = {
    call: vi.fn(async (_name: string, op: Operation, input: Record<string, unknown>, _options: unknown) => {
      const respond = options.responses?.[op.id]
      if (!respond) throw new Error(`Unexpected Operation ${op.id}`)
      return respond(input)
    }),
    decide: vi.fn(async (_name: string, _actor: unknown, op: { effect: "read" | "write", id: string }) => options.decisions?.[op.id] ?? (op.effect === "read" ? "allow" : "deny")),
    fetch: vi.fn(),
    record: vi.fn(options.record ?? (async () => {})),
  }
  const primitive = {
    operations: {
      gmail: {
        draftsCreate: operation("gmail.drafts.create", "write"),
        messagesGet: operation("gmail.messages.get", "read"),
        messagesList: operation("gmail.messages.list", "read"),
      },
    },
    runtime: () => runtime,
  }
  return { primitive, runtime }
}

const event = { id: "event_1" }

function context(primitive: unknown) {
  return {
    agentIdentity: { name: "labeller" },
    capabilities: { connections: primitive },
    context: new Map([[agentInvocationTraceIdContextKey, "trace_1"]]),
    event,
    run: { runId: "run_1" },
  }
}

async function tools(capability: AgentCapabilityDefinition, primitive: unknown): Promise<Record<string, AgentToolDefinition>> {
  if (typeof capability.tools !== "function") throw new Error("gmail capability must expose a tool resolver")
  // SAFETY: The Gmail tools read only the fields that the fake context sets.
  return await capability.tools(context(primitive) as never) as Record<string, AgentToolDefinition>
}

async function run(tool: AgentToolDefinition | undefined, input: unknown): Promise<unknown> {
  if (!tool?.execute) throw new Error("expected an executable tool")
  // SAFETY: The Gmail tools do not read the execution options.
  return await tool.execute(input as never, {} as never)
}

async function decide(tool: AgentToolDefinition | undefined): Promise<unknown> {
  if (typeof tool?.policy !== "function") throw new Error("expected a tool policy")
  return await tool.policy({ name: tool.name })
}

const message = {
  id: "m1",
  labelIds: ["INBOX"],
  payload: {
    headers: [
      { name: "From", value: "Alice <alice@example.com>" },
      { name: "To", value: "bob@example.com" },
      { name: "Subject", value: "Hello" },
      { name: "Date", value: "Mon, 28 Sep 2026 10:00:00 +0000" },
      { name: "X-Other", value: "ignored" },
    ],
    mimeType: "multipart/mixed",
    parts: [
      { body: { data: base64Url("Plain body ü") }, mimeType: "text/plain" },
      { body: { data: base64Url("<p>HTML body</p>") }, mimeType: "text/html" },
      { body: { attachmentId: "a1", size: 12 }, filename: "report.pdf", mimeType: "application/pdf" },
    ],
  },
  snippet: "Plain body",
  threadId: "t1",
}

describe("gmail capability", () => {
  it("defines tools, requirements, and inspection from the enabled operations", async () => {
    const { primitive } = connections()
    const read = gmail()
    expect(read).toMatchObject({
      id: "gmail",
      metadata: { connection: "google", operations: ["search", "read"] },
      mode: "read",
      requires: [{ primitive: "connections" }],
    })
    expect(Object.keys(await tools(read, primitive)).sort()).toEqual(["gmail_read", "gmail_search"])

    const draft = gmail({ connection: "work-google", operations: ["search", "draft"] })
    expect(draft).toMatchObject({ metadata: { connection: "work-google", operations: ["search", "draft"] }, mode: "write" })
    const draftTools = await tools(draft, primitive)
    expect(Object.keys(draftTools).sort()).toEqual(["gmail_draft", "gmail_search"])
    expect(draftTools.gmail_draft?.metadata).toEqual({ connection: { name: "work-google", operation: "gmail.drafts.create" } })

    // Model Drivers can use Gmail because the Connection runs on the server.
    expect(() => validateAgentCapabilityComposition([draft], { driverKind: "model", hasWorkspace: false })).not.toThrow()
    const inspected = createAgentInspectionMetadata(defineAgent({ capabilities: [draft], driver: "codex", workspace: { mode: "write" } }))
    expect(inspected.tools).toContainEqual(expect.objectContaining({
      commands: ["gmail_search", "gmail_draft"],
      description: "Search, read, or draft Gmail messages through the \"work-google\" Connection.",
      name: "gmail",
    }))
  })

  it("rejects invalid options and a missing primitive", async () => {
    expect(() => gmail({ operations: ["send" as never] })).toThrow("gmail() requires")
    expect(() => gmail({ operations: [] })).toThrow("gmail() requires")
    expect(() => gmail({ connection: " " })).toThrow("gmail() requires")
    await expect(tools(gmail(), undefined)).rejects.toThrow("requires the connections primitive")
    await expect(tools(gmail(), { runtime: "nope" })).rejects.toThrow("requires the connections primitive to expose runtime()")
    await expect(tools(gmail(), { runtime: () => ({}) })).rejects.toThrow("expose the Gmail Operations")
  })

  it("searches through the Connection with the Agent actor and invocation trace", async () => {
    const { primitive, runtime } = connections({
      responses: {
        "gmail.messages.get": input => ({ ...message, id: String(input.id) }),
        "gmail.messages.list": () => ({ messages: [{ id: "m1", threadId: "t1" }], nextPageToken: "next" }),
      },
    })
    const result = await run((await tools(gmail(), primitive)).gmail_search, { max: 5, query: " from:alice " })
    expect(result).toEqual({
      messages: [{
        date: "Mon, 28 Sep 2026 10:00:00 +0000",
        from: "Alice <alice@example.com>",
        id: "m1",
        labelIds: ["INBOX"],
        snippet: "Plain body",
        subject: "Hello",
        threadId: "t1",
        to: "bob@example.com",
      }],
      nextPageToken: "next",
      query: "from:alice",
    })
    expect(runtime.call.mock.calls.map(([name, op, input]) => [name, op.id, input])).toEqual([
      ["google", "gmail.messages.list", { maxResults: 5, q: "from:alice" }],
      ["google", "gmail.messages.get", { format: "metadata", id: "m1", metadataHeaders: ["From", "To", "Cc", "Subject", "Date"] }],
    ])
    expect(runtime.call.mock.calls[0]?.[3]).toEqual({
      actor: { id: "labeller", kind: "agent" },
      audit: "all",
      event,
      trace: { invocationId: "trace_1", runId: "run_1", tool: "gmail_search" },
    })
    await expect(run((await tools(gmail(), primitive)).gmail_search, { max: 51 })).rejects.toThrow("from 1 to 50")
  })

  it("reads the text body, falls back to HTML, and truncates", async () => {
    const html = { ...message, payload: { ...message.payload, parts: [message.payload.parts[1]!] } }
    const { primitive } = connections({
      responses: { "gmail.messages.get": input => input.id === "html" ? html : message },
    })
    const readTools = await tools(gmail(), primitive)
    expect(await run(readTools.gmail_read, { id: "m1" })).toMatchObject({
      attachments: [{ filename: "report.pdf", mimeType: "application/pdf", size: 12 }],
      subject: "Hello",
      text: "Plain body ü",
      truncated: false,
    })
    expect(await run(readTools.gmail_read, { id: "html" })).toMatchObject({ text: "HTML body" })
    const long = { ...message, payload: { mimeType: "text/plain", body: { data: base64Url("x".repeat(600)) } } }
    const { primitive: longPrimitive } = connections({ responses: { "gmail.messages.get": () => long } })
    expect(await run((await tools(gmail(), longPrimitive)).gmail_read, { id: "m1", maxChars: 500 })).toMatchObject({ text: "x".repeat(500), truncated: true })
    await expect(run(readTools.gmail_read, { id: "a\nb" })).rejects.toThrow("one line")
  })

  it("rejects an unexpected Gmail response", async () => {
    const { primitive } = connections({ responses: { "gmail.messages.get": () => ({ id: 1 }) } })
    await expect(run((await tools(gmail(), primitive)).gmail_read, { id: "m1" })).rejects.toThrow("unexpected Gmail response")
  })

  it("creates an unsent draft as an RFC 2822 message", async () => {
    const { primitive, runtime } = connections({
      responses: { "gmail.drafts.create": () => ({ id: "d1", message: { id: "m2", threadId: "t1" } }) },
    })
    const draftTools = await tools(gmail({ operations: ["draft"] }), primitive)
    const body = `Hallo Bob ✓\n${"y".repeat(100)}`
    expect(await run(draftTools.gmail_draft, {
      body,
      cc: ["carol@example.com"],
      subject: "Grüße",
      threadId: "t1",
      to: ["bob@example.com"],
    })).toEqual({ draftId: "d1", messageId: "m2", sent: false, threadId: "t1" })

    const input = runtime.call.mock.calls[0]?.[2]
    expect(input?.threadId).toBe("t1")
    const raw = decodeBase64Url(String(input?.raw))
    const [head = "", encoded = ""] = raw.split("\r\n\r\n")
    expect(head.split("\r\n")).toEqual([
      "To: bob@example.com",
      "Cc: carol@example.com",
      `Subject: =?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode("Grüße")))}?=`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
    ])
    expect(encoded.split("\r\n").every(line => line.length <= 76)).toBe(true)
    expect(new TextDecoder().decode(Uint8Array.from(atob(encoded.replaceAll("\r\n", "")), character => character.charCodeAt(0)))).toBe(body)

    await expect(run(draftTools.gmail_draft, { body: "x", subject: "Hi\nBcc: evil@example.com", to: ["bob@example.com"] })).rejects.toThrow("one line")
    await expect(run(draftTools.gmail_draft, { body: "x", subject: "Hi", to: ["bob@example.com\r\nBcc: evil@example.com"] })).rejects.toThrow("valid email")
    await expect(run(draftTools.gmail_draft, { body: "x", subject: "Hi", to: [] })).rejects.toThrow("at least one email")
    expect(runtime.call).toHaveBeenCalledTimes(1)
  })

  it("records denied and approval-required outcomes before the tool runs", async () => {
    const denied = connections()
    const draftTools = await tools(gmail({ operations: ["search", "draft"] }), denied.primitive)
    expect(await decide(draftTools.gmail_draft)).toBe("deny")
    expect(denied.runtime.record).toHaveBeenCalledWith({
      action: "call",
      actor: { id: "labeller", kind: "agent" },
      connection: "google",
      effect: "write",
      invocationId: "trace_1",
      operation: "gmail.drafts.create",
      outcome: "denied",
      runId: "run_1",
      tool: "gmail_draft",
    }, event)
    expect(await decide(draftTools.gmail_search)).toBe("allow")
    expect(denied.runtime.decide.mock.calls.map(([, , op]) => op.id)).toEqual(["gmail.drafts.create", "gmail.messages.list", "gmail.messages.get"])

    const approval = connections({ decisions: { "gmail.drafts.create": "require-approval" } })
    expect(await decide((await tools(gmail({ operations: ["draft"] }), approval.primitive)).gmail_draft)).toBe("require-approval")
    expect(approval.runtime.record).toHaveBeenCalledWith(expect.objectContaining({ operation: "gmail.drafts.create", outcome: "approval-required" }), event)

    const readDenied = connections({ decisions: { "gmail.messages.get": "deny" } })
    expect(await decide((await tools(gmail(), readDenied.primitive)).gmail_search)).toBe("deny")
    expect(readDenied.runtime.record).toHaveBeenCalledWith(expect.objectContaining({ operation: "gmail.messages.get", outcome: "denied", tool: "gmail_search" }), event)
  })

  it("keeps a denial when the activity store fails", async () => {
    const { primitive } = connections({ record: async () => { throw new Error("database unavailable") } })
    expect(await decide((await tools(gmail({ operations: ["draft"] }), primitive)).gmail_draft)).toBe("deny")
  })
})
