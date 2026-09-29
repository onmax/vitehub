import { afterEach, describe, expect, it, vi } from "vitest"

import { workflowDevHeader, workflowDevHeaderValue, workflowDevRuntimeRoute } from "../src/dev-support.ts"
import { createWorkflowError } from "../src/errors.ts"
import { createWorkflowDevRequestHandler } from "../src/runtime/dev.ts"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig } from "../src/runtime/state.ts"

vi.mock("../src/runtime/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/client.ts")>()
  return {
    ...actual,
    resumeWorkflowSignal: vi.fn(async () => {
      throw createWorkflowError({
        cause: new Error("Hook not found for postgres://admin:hunter2@db.example.com/app"),
        code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
        details: { operation: "resume-signal", provider: "vercel" },
      })
    }),
  }
})

afterEach(() => {
  resetWorkflowRuntime()
})

describe("Workflow dev provider failures", () => {
  it("reports the redacted provider reason with a 502 status", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    const handle = createWorkflowDevRequestHandler({ configuredProvider: "vercel" })
    const response = await handle(new Request(`http://localhost:5173${workflowDevRuntimeRoute}`, {
      body: JSON.stringify({ operation: "resume", token: "tok_unknown" }),
      headers: { [workflowDevHeader]: workflowDevHeaderValue, "content-type": "application/json" },
      method: "POST",
    }))
    const text = await response.text()

    expect(response.status).toBe(502)
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "WORKFLOW_PROVIDER_OPERATION_FAILED", message: expect.stringMatching(/^workflow resume failed in the vercel provider\. Hook not found for /) },
    })
    expect(text).not.toContain("hunter2")
  })
})
