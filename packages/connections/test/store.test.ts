import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { describe, expect, it } from "vitest"

import { createDatabaseConnectionStore } from "../src/store.ts"

describe("stored Connection scopes", () => {
  it("rejects corrupt scopes instead of reporting a partial grant", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      const db = drizzle(client)
      const store = createDatabaseConnectionStore({ db, encryptionKey: new Uint8Array(32).fill(9) })
      await store.state.put({ name: "mail", scopes: ["mail.read"], status: "connected", updatedAt: "2026-09-30T00:00:00Z" })
      expect((await store.state.get("mail"))?.scopes).toEqual(["mail.read"])
      for (const scopes of ['["mail.read", 42]', '{}', 'null']) {
        await db.run(sql`UPDATE vitehub_connection_state SET scopes = ${scopes} WHERE name = 'mail'`)
        await expect(store.state.get("mail")).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
      }
    }
    finally {
      client.close()
    }
  })
})
