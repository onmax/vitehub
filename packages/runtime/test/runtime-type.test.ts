import { describe, expect, it, vi } from "vitest"

import { hasRuntimeType, runtimeType } from "../src/internal/runtime-type.ts"

describe("Runtime representation guards", () => {
  it.each([
    [undefined, "undefined"],
    [null, "object"],
    ["value", "string"],
    [1, "number"],
    [true, "boolean"],
    [1n, "bigint"],
    [Symbol("value"), "symbol"],
    [() => undefined, "function"],
    [class {}, "function"],
  ] as const)("classifies %s as %s", (value, expected) => {
    expect(runtimeType(value)).toBe(expected)
    expect(hasRuntimeType(value, expected)).toBe(true)
  })

  it("treats boxed values as objects and leaves hostile getters untouched", () => {
    const read = vi.fn(() => { throw new Error("blocked property") })
    const hostile = new Proxy({}, { get: read })
    expect(runtimeType(hostile)).toBe("object")
    expect(hasRuntimeType(hostile, "object")).toBe(true)
    expect(read).not.toHaveBeenCalled()
    expect(runtimeType(Object(1))).toBe("object")
    expect(hasRuntimeType(Object(1), "number")).toBe(false)
  })

  it("distinguishes callable and object representations", () => {
    expect(hasRuntimeType(null, "object")).toBe(true)
    expect(hasRuntimeType({}, "object")).toBe(true)
    expect(hasRuntimeType(() => undefined, "function")).toBe(true)
    const spoofed = { [Symbol.toStringTag]: "Function" }
    expect(hasRuntimeType(spoofed, "function")).toBe(false)
    expect(hasRuntimeType(spoofed, "object")).toBe(true)
    const hostile = new Proxy({}, { get() { throw new Error("blocked property") } })
    expect(hasRuntimeType(hostile, "object")).toBe(true)
    expect(hasRuntimeType(hostile, "function")).toBe(false)
  })
})
