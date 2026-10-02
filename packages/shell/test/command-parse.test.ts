import { describe, expect, it } from "vitest"

import { parseShellCommand } from "../src/command/parse.ts"

describe("shell command parsing", () => {
  it("keeps backslashes literal inside single quotes", () => {
    expect(parseShellCommand("printf '%s\\n' 'hello'"))
      .toEqual(["printf", "%s\\n", "hello"])
  })

  it("retains empty quoted arguments", () => {
    expect(parseShellCommand("cmd '' \"\" end"))
      .toEqual(["cmd", "", "", "end"])
  })
})
