import { afterEach, describe, expect, it } from "vitest"

import { emailConsoleSection } from "../src/console.ts"
import { emailDevHeader, emailDevHeaderValue, emailDevRuntimeRoute } from "../src/dev.ts"
import {
  emailConsoleHtmlSourceLimit,
  handleDisabledEmailDevRequest,
  handleEmailDevRequest,
  listEmailOutbox,
  readEmailOutboxConsoleRecords,
} from "../src/runtime/console.ts"
import { createEmailDevOutboxDriver } from "../src/runtime/outbox.ts"

import type { EmailDriver, EmailMessage } from "../src/types.ts"

const outboxState = Symbol.for("vitehub.email.outbox")

afterEach(() => {
  Reflect.deleteProperty(globalThis, outboxState)
})

const message: EmailMessage = {
  attachments: [{ content: "x".repeat(2048), contentType: "application/pdf", filename: "invoice.pdf" }],
  from: "hello@example.com",
  headers: { "X-Api-Key": "re_live_secret" },
  html: "<p onclick=\"steal()\">Hi <img src=x onerror=alert(1)></p>",
  subject: "Invoice",
  text: "Your invoice.",
  to: "ada@example.com",
}

async function capture(input: EmailMessage = message, limit?: number): Promise<void> {
  const driver: EmailDriver = await createEmailDevOutboxDriver({ deliver: false, driver: () => {
    throw new Error("The provider driver must not be created.")
  }, limit, provider: "resend" })
  await driver.send(input, { attempt: 1, driver: driver.name, meta: {} })
}

function devRequest(body: unknown, init: { headers?: Record<string, string>, method?: string } = {}): Request {
  const method = init.method ?? "POST"
  return new Request(`http://localhost${emailDevRuntimeRoute}`, {
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", [emailDevHeader]: emailDevHeaderValue, ...init.headers },
    method,
  })
}

describe("Email outbox runtime reader", () => {
  it("returns no records without an outbox", () => {
    expect(readEmailOutboxConsoleRecords()).toEqual([])
    expect(listEmailOutbox()).toEqual({ limit: null, messages: [] })
  })

  it("maps captured messages to Console records without secrets", async () => {
    await capture()
    await capture({ ...message, subject: "Reminder" })

    const records = readEmailOutboxConsoleRecords()
    expect(records.map(record => record.id)).toEqual(["outbox-2", "outbox-1"])
    const record = records[1]!
    expect(record.cells).toEqual({
      captured: expect.any(String),
      delivery: "Captured only",
      provider: "resend",
      subject: "Invoice",
      to: "ada@example.com",
    })
    const fields = Object.fromEntries(record.fields.map(field => [field.label, field.value]))
    expect(fields).toMatchObject({
      "Attachments": "invoice.pdf (application/pdf, 2.0 KB)",
      "Delivery": "Captured only",
      "From": "hello@example.com",
      "Headers": "X-Api-Key: [redacted]",
      "Text body": "Your invoice.",
    })
    expect(new Set(record.fields.map(field => field.label)).size).toBe(record.fields.length)
    expect(JSON.stringify(records)).not.toContain("re_live_secret")
  })

  it("returns HTML as plain source text and truncates long HTML", async () => {
    await capture()
    await capture({ ...message, html: `<div>${"a".repeat(emailConsoleHtmlSourceLimit + 10)}</div>` })

    const [long, short] = readEmailOutboxConsoleRecords()
    const shortHtml = short?.fields.find(field => field.label === "HTML source")?.value
    expect(shortHtml).toBe(message.html)
    const longHtml = long?.fields.find(field => field.label === "HTML source")?.value
    expect(typeof longHtml).toBe("string")
    expect(String(longHtml)).toHaveLength(emailConsoleHtmlSourceLimit + "\n... 21 more characters. Use `vitehub email outbox show outbox-2 --html`.".length)
    expect(String(longHtml)).toContain("Use `vitehub email outbox show outbox-2 --html`.")
  })

  it("declares a runtime record-table section that the Console renders as text", async () => {
    expect(emailConsoleSection).toMatchObject({
      id: "email",
      runtime: { export: "readEmailOutboxConsoleRecords", module: "@vite-hub/email/runtime/console" },
      view: { kind: "record-table" },
    })
    expect(emailConsoleSection.view.columns.map(column => column.key)).toEqual(["subject", "to", "provider", "delivery", "captured"])
    const records = await import("../src/runtime/console.ts")
    expect(records[emailConsoleSection.runtime.export as "readEmailOutboxConsoleRecords"]).toBeTypeOf("function")
  })
})

describe("Email Dev runtime handler", () => {
  it("rejects requests without the guard, from another origin, or with another method or content type", async () => {
    const missingHeader = new Request(`http://localhost${emailDevRuntimeRoute}`, {
      body: "{\"operation\":\"list\"}",
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect((await handleEmailDevRequest(missingHeader)).status).toBe(403)
    expect((await handleEmailDevRequest(devRequest({ operation: "list" }, { headers: { origin: "https://attacker.test" } }))).status).toBe(403)
    expect((await handleEmailDevRequest(devRequest(undefined, { method: "GET" }))).status).toBe(405)
    expect((await handleEmailDevRequest(devRequest({ operation: "list" }, { headers: { "content-type": "text/plain" } }))).status).toBe(415)
    expect((await handleEmailDevRequest(devRequest("{"))).status).toBe(400)
    expect((await handleEmailDevRequest(devRequest({ operation: "send" }))).status).toBe(400)
    expect((await handleEmailDevRequest(devRequest({ id: 3, operation: "get" }))).status).toBe(400)
    expect((await handleEmailDevRequest(devRequest({ operation: "get" }))).status).toBe(400)
  })

  it("lists, shows, and clears captured messages", async () => {
    await capture()

    const list = await handleEmailDevRequest(devRequest({ operation: "list" }))
    expect(list.headers.get("cache-control")).toBe("no-store")
    expect(await list.json()).toEqual({
      limit: 50,
      messages: [{
        attachments: 1,
        capturedAt: expect.any(String),
        delivery: { status: "captured" },
        from: "hello@example.com",
        id: "outbox-1",
        provider: "resend",
        subject: "Invoice",
        to: ["ada@example.com"],
      }],
    })

    const shown = await handleEmailDevRequest(devRequest({ id: "outbox-1", operation: "get" }))
    expect(await shown.json()).toMatchObject({ message: { headers: { "X-Api-Key": "[redacted]" }, html: message.html, id: "outbox-1", text: "Your invoice." } })

    const missing = await handleEmailDevRequest(devRequest({ id: "outbox-9", operation: "get" }))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: "EMAIL_OUTBOX_MESSAGE_NOT_FOUND" } })

    expect(await (await handleEmailDevRequest(devRequest({ operation: "clear" }))).json()).toEqual({ cleared: 1 })
    expect(await (await handleEmailDevRequest(devRequest({ operation: "list" }))).json()).toEqual({ limit: 50, messages: [] })
  })

  it("reports a disabled outbox after it checks the guard", async () => {
    const response = await handleDisabledEmailDevRequest(devRequest({ operation: "list" }))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: "EMAIL_OUTBOX_DISABLED" } })
    expect((await handleDisabledEmailDevRequest(devRequest(undefined, { method: "GET" }))).status).toBe(405)
  })
})
