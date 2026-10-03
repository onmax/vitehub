import { describe, expect, it } from "vitest"
import { isRecord, isRuntimeEnvEntry, isRuntimeProviderEntry, runtimeRegistryEntries } from "../src/core/registry.ts"

describe("Runtime declaration registry", () => {
  it("rejects malformed declarations without coercing fields", () => {
    const host = { required: true, secret: false, source: { kind: "env", name: "TOKEN" } }
    const provider = { required: true, secret: false, source: { kind: "provider", key: "token", provider: "vault" } }
    expect(isRuntimeEnvEntry(host)).toBe(true)
    expect(isRuntimeProviderEntry(provider)).toBe(true)
    for (const value of [null, undefined, [], "token", 1, true]) {
      expect(isRecord(value)).toBe(false)
      expect(isRuntimeEnvEntry(value)).toBe(false)
      expect(isRuntimeProviderEntry(value)).toBe(false)
    }
    expect(isRuntimeEnvEntry({ ...host, required: "true" })).toBe(false)
    expect(isRuntimeEnvEntry({ ...host, secret: 0 })).toBe(false)
    expect(isRuntimeEnvEntry({ ...host, source: { kind: "env", name: 1 } })).toBe(false)
    expect(isRuntimeProviderEntry({ ...provider, source: { ...provider.source, key: 1 } })).toBe(false)
    expect(isRuntimeProviderEntry({ ...provider, source: { ...provider.source, provider: null } })).toBe(false)
  })

  it("keeps literal values and declaration metadata opaque and preserves entry identity", () => {
    const nestedEntry = { required: true, secret: false, source: { kind: "env", name: "HIDDEN" } }
    const token = { required: true, secret: false, source: { kind: "provider", provider: "vault", key: "token" }, default: nestedEntry }
    const literal = { kind: "literal", value: { nestedEntry } }
    const entries = [...runtimeRegistryEntries({ nested: { token }, literal })]
    expect(entries.map(({ path }) => path)).toEqual(["env.server.nested.token", "env.server.literal"])
    expect(entries[0]?.entry).toBe(token)
    expect(entries[1]?.entry).toBe(literal)
  })
})
