import { describe, expect, it, vi } from "vitest"

import { runTypecheck, typecheckEnvironment } from "./typecheck.mjs"

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

  it("runs each phase through Node and stops after a failure", async () => {
    const execute = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(7)

    expect(await runTypecheck({}, execute)).toBe(7)
    expect(execute).toHaveBeenCalledTimes(2)
    const [command, buildArgs, environment] = execute.mock.calls[0]!
    expect(command).toBe(process.execPath)
    expect(buildArgs.slice(1)).toEqual(["run", "build"])
    expect(environment.NODE_OPTIONS).toBe("--max-old-space-size=4096")
    expect(execute.mock.calls[1]![1].slice(1)).toEqual([
      "run", "--filter", "vitehub-docs", "--ignore-depends-on", "typecheck",
    ])
  })
})
