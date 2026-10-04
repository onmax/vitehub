import { describe, expect, it } from "vitest"

import { isApiKeyProvider } from "../src/api-key.ts"

describe("API-key provider markers", () => {
  it("does not infer an API-key provider from an inherited kind marker", () => {
    const provider = Object.create({ kind: "api-key" })
    expect(isApiKeyProvider(provider as never)).toBe(false)
  })
})
