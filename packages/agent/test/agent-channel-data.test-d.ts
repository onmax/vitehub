import { expectTypeOf } from "vitest"

import { defineAgent } from "../src/index.ts"
import { gmail } from "../src/channels.ts"
import type { GmailMessage } from "../src/channels.ts"

defineAgent({
  channels: { gmail: gmail() },
  driver: { run: () => "ok" },
  intercept: ({ data }) => {
    expectTypeOf(data).toEqualTypeOf<GmailMessage>()
    return data.subject.includes("invoice") ? ["Orders"] : undefined
  },
})
