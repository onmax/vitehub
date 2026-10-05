import { describe, expect, it } from "vitest"

import { resolveAgentRoutePath } from "../src/internal/routes.ts"

describe("agent route paths", () => {
  it("does not resolve route placeholders through Object.prototype", () => {
    expect(resolveAgentRoutePath("/hooks/[toString]/[agent]", { agent: "support" })).toBe("/hooks/:toString/support")
  })
})
