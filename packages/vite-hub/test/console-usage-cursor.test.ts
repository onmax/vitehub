import { describe, expect, it } from "vitest"

import { usageCursor, usageQueryWindow } from "../src/console/runtime/server/usage.ts"

describe("Console usage cursors", () => {
  it("rejects non-URL-safe encodings while accepting generated cursors", () => {
    const options = { agentName: "chat", now: "2026-08-27T12:00:00.000Z", window: "24h" as const }
    const to = "2026-08-27T12:00:00.000Z"
    const cursor = usageCursor(options, to, { at: to, id: "run" })

    expect(usageQueryWindow({ ...options, cursor }).after).toMatchObject({ at: to, id: "run" })
    expect(() => usageQueryWindow({ ...options, cursor: `${cursor}==` })).toThrow()
    expect(() => usageQueryWindow({ ...options, cursor: ` ${cursor}` })).toThrow()
  })
})
