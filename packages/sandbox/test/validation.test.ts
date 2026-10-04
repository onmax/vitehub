import { describe, expect, it } from "vitest"

import { bundleSandboxDefinition } from "../src/bundle.ts"
import { readValidatedPayload } from "../src/internal/shared/validation.ts"

describe("Sandbox validation", () => {
  it("does not execute a Standard Schema validator inherited from a foreign prototype", async () => {
    let calls = 0
    const validate = Object.create({
      "~standard": {
        validate: async () => {
          calls++
          return { value: "accepted" }
        },
      },
    })

    await expect(readValidatedPayload("payload", validate as never)).rejects.toMatchObject({
      code: "SANDBOX_VALIDATION_ERROR",
    })
    expect(calls).toBe(0)
  })

  it("emits the own-property check in bundled validation runtime", async () => {
    const bundle = await bundleSandboxDefinition(
      "import { readValidatedPayload } from '@vite-hub/sandbox'; export default { run: async input => readValidatedPayload(input, input.validate) }",
      "/fixture/run.sandbox.ts",
      { execution: "definition", includeProject: false },
    )

    expect(bundle.modules[bundle.entry]).toContain('Object.hasOwn(value, "~standard")')
  })
})
