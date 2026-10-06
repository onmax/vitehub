import { describe, expectTypeOf, it } from "vitest"

import { createEnvAuthenticator } from "../src/auth.ts"
import type { EnvAccessContext, EnvBridge, EnvGrantedAccessContext } from "../src/bridge.ts"

declare const bridge: EnvBridge
declare const granted: EnvGrantedAccessContext
const actor = { kind: "user", id: "owner" } as const

describe("Env access grants", () => {
  it("accepts actor contexts and contexts that Env created", () => {
    expectTypeOf(createEnvAuthenticator).returns.toEqualTypeOf<(request: Request) => Promise<EnvAccessContext | null>>()
    void bridge.inspect({ actor }, "token")
    void bridge.inspect({ actor, admin: false, scope: [{ key: "token", permissions: ["inspect"] }] }, "token")
    void bridge.grants(granted, "token")
  })

  it("rejects administrator contexts that application code builds", () => {
    // @ts-expect-error Only Env creates administrator contexts.
    void bridge.grants({ actor, admin: true }, "token")
    // @ts-expect-error A boolean flag cannot become administrator access.
    const flagged: EnvAccessContext = { actor, admin: Boolean(actor.id) }
    // @ts-expect-error A granted context has no scope. Its authority comes from Env.
    const widened: EnvAccessContext = { ...granted, scope: [{ key: "token", permissions: ["use"] }] }
    // @ts-expect-error Granted contexts are frozen.
    granted.actor = actor
    void flagged
    void widened
  })
})
