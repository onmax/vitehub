import { afterEach, describe, expect, it, vi } from "vitest"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

import { createRuntimeEnvConfigValue } from "../src/config-value.ts"
import { createCloudflareD1HttpResolver } from "../src/runtime/d1-http.ts"

const schema = { notes: sqliteTable("notes", { id: integer("id"), title: text("title") }) }

function configuration() {
  return {
    name: "notes",
    drizzle: {},
    cloudflare: {
      databaseId: "notes-id",
      http: {
        authToken: createRuntimeEnvConfigValue(["DESIGN_D1_TOKEN"]),
        url: createRuntimeEnvConfigValue(["DESIGN_D1_URL"]),
      },
    },
  }
}

afterEach(() => vi.unstubAllEnvs())

describe("Cloudflare D1 HTTP resolver", () => {
  it("shares matching connections and uses current credentials through the injected transport", async () => {
    vi.stubEnv("DESIGN_D1_TOKEN", "first-token")
    vi.stubEnv("DESIGN_D1_URL", "https://d1.example.com/first")
    const request = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => Response.json({
      success: true,
      result: [{ success: true, results: { rows: [[1, "hello"]] } }],
    }))
    const getDatabase = createCloudflareD1HttpResolver(configuration(), schema, request)
    const first = getDatabase()
    expect(getDatabase()).toBe(first)
    await expect(first.select().from(schema.notes)).resolves.toEqual([{ id: 1, title: "hello" }])

    vi.stubEnv("DESIGN_D1_TOKEN", "second-token")
    const second = getDatabase()
    expect(second).not.toBe(first)
    expect(getDatabase()).toBe(second)
    await second.select().from(schema.notes)
    vi.stubEnv("DESIGN_D1_URL", "https://d1.example.com/second")
    expect(getDatabase()).not.toBe(second)
    await getDatabase().select().from(schema.notes)

    expect(request.mock.calls.map(([url, options]) => [url, options?.headers])).toEqual([
      ["https://d1.example.com/first", { Authorization: "Bearer first-token", "Content-Type": "application/json" }],
      ["https://d1.example.com/first", { Authorization: "Bearer second-token", "Content-Type": "application/json" }],
      ["https://d1.example.com/second", { Authorization: "Bearer second-token", "Content-Type": "application/json" }],
    ])
    vi.stubEnv("DESIGN_D1_TOKEN", "")
    expect(getDatabase).toThrow("requires cloudflare.http.url and cloudflare.http.authToken")
  })
})
