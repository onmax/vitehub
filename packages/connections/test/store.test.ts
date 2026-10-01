import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core"
import { describe, expect, it, vi } from "vitest"

import { createConnectionsHandler } from "../src/http.ts"
import { createDatabaseConnectionStore } from "../src/store.ts"
import { createTestRuntime } from "./helpers.ts"

import type { ConnectionApprovalSummaryPage } from "../src/types.ts"

describe("database approval summaries", () => {
  it("projects paged HTTP summaries without selecting or parsing full inputs and preserves raw details", async () => {
    const client = createClient({ url: ":memory:" })
    const db = drizzle(client)
    const store = createDatabaseConnectionStore({ db, encryptionKey: new Uint8Array(32).fill(3) })
    const input = { body: "private-provider-input".repeat(4096) }
    try {
      for (let index = 0; index < 101; index++) {
        await store.approvals.create({ action: "mail.messages.modify", actor: "agent:mail", createdAt: "2026-09-29T10:00:00.000Z", id: `approval-${index}`, input, name: "mail", status: "pending" })
      }
      await store.approvals.create({ action: "mail.messages.modify", actor: "agent:mail", createdAt: "2026-09-29T10:00:00.000Z", id: "excluded-status", input, name: "mail", status: "denied" })
      await store.approvals.create({ action: "mail.messages.modify", actor: "agent:mail", createdAt: "2026-09-29T10:00:00.000Z", id: "excluded-name", input, name: "other", status: "pending" })
      // A summary must remain readable even when the stored input cannot be parsed.
      await db.run(sql`UPDATE vitehub_connection_approvals SET input = 'invalid-json' WHERE id = 'approval-100'`)
      const reads = vi.spyOn(db, "all")
      const handler = createConnectionsHandler({ runtime: () => createTestRuntime(undefined, store).runtime })
      const page = async (before?: string) => {
        const response = await handler(new Request("http://localhost:5173/_vitehub/connections", {
          body: JSON.stringify({ action: "approval-summaries", name: "mail", status: "pending", ...(before ? { before } : {}) }),
          headers: { "content-type": "application/json", origin: "http://localhost:5173" },
          method: "POST",
        }))
        expect(response.status).toBe(200)
        // SAFETY: This real handler serializes the store-owned approval summary page.
        return await response.json() as ConnectionApprovalSummaryPage
      }
      const first = await page()
      expect(first.approvals).toHaveLength(100)
      expect(first.nextCursor).toBe("approval-1")
      expect(first.approvals[0]).toEqual({ action: "mail.messages.modify", actor: "agent:mail", createdAt: "2026-09-29T10:00:00.000Z", id: "approval-100", name: "mail", status: "pending" })
      expect(await page(first.nextCursor)).toEqual({ approvals: [expect.objectContaining({ id: "approval-0" })] })
      const dialect = new SQLiteAsyncDialect()
      const selects = reads.mock.calls.map(([query]) => typeof query === "string" ? query : dialect.sqlToQuery(query.getSQL()).sql)
      expect(selects).toHaveLength(2)
      for (const query of selects) {
        expect(query).toMatch(/ORDER BY sequence DESC LIMIT 101/)
        expect(query.split(" FROM ")[0]).not.toMatch(/\binput\b|\*/)
      }
      expect(JSON.stringify(first)).not.toContain("private-provider-input")
      await db.run(sql`UPDATE vitehub_connection_approvals SET input = ${JSON.stringify(input)} WHERE id = 'approval-100'`)
      expect((await store.approvals.list({ name: "mail", status: "pending" })).approvals[0]).toMatchObject({ id: "approval-100", input })
    } finally {
      client.close()
    }
  })
})
