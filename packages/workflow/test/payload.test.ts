import { describe, expect, it } from "vitest"

import { validatePayload } from "../src/runtime/payload.ts"

describe("workflow payload validation", () => {
  it("accepts safeParse schemas", async () => {
    await expect(validatePayload("hello", {
      safeParse: value => ({ success: true, data: String(value) }),
    })).resolves.toBe("hello")
  })

  it("accepts parse schemas", async () => {
    await expect(validatePayload("hello", {
      parse: value => String(value).toUpperCase(),
    })).resolves.toBe("HELLO")
  })

  it("rejects schemas that inherit parser methods", async () => {
    const inherited = {
      safeParse: () => ({ success: true, data: "inherited" }),
      parse: () => "inherited",
    }

    await expect(validatePayload("hello", Object.create(inherited))).rejects.toMatchObject({ code: "WORKFLOW_R0022" })
  })

  it("accepts parser functions", async () => {
    await expect(validatePayload("hello", value => String(value).length)).resolves.toBe(5)
  })
})
