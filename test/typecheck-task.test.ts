import { describe, expect, it } from "vitest"

import { typecheckEnvironment } from "./typecheck.mjs"

describe("root typecheck task environment", () => {
  it("provides a default heap size when NODE_OPTIONS is absent", () => {
    expect(typecheckEnvironment({ PATH: "/bin" })).toMatchObject({
      NODE_OPTIONS: "--max-old-space-size=4096",
      PATH: "/bin",
    })
  })

  it("preserves caller-provided NODE_OPTIONS", () => {
    expect(typecheckEnvironment({ NODE_OPTIONS: "--trace-warnings" })).toEqual({ NODE_OPTIONS: "--trace-warnings" })
  })
})
