import { describe, expectTypeOf, it } from "vitest"

import { defineConnection } from "../src/definition.ts"
import { google } from "../src/google.ts"

import type { GmailLabel } from "../src/google.ts"
import type { ConnectionClient, ConnectionDefinition } from "../src/types.ts"

const connection = defineConnection({
  access: {
    "agent:labeller": { read: true, write: "approve" },
    "schedule:gmail": { read: true, write: ["gmail.users.messages.modify"] },
  },
  api: { gmail: ["users.labels.*", "users.messages.get", "users.messages.list", "users.messages.modify"] },
  provider: google({ clientId: "id", clientSecret: () => "secret" }),
  scopes: ["https://www.googleapis.com/auth/gmail.modify"],
})

type Client = typeof connection extends ConnectionDefinition<infer TApis, infer TSelection> ? ConnectionClient<TApis, TSelection> : never
declare const client: Client

describe("Connection types", () => {
  it("exposes only selected methods", () => {
    expectTypeOf(client.gmail.users.labels.list).toBeFunction()
    expectTypeOf(client.gmail.users.messages.modify).toBeFunction()
    // @ts-expect-error users.messages.send is not selected.
    expectTypeOf(client.gmail.users.messages.send).toBeFunction()
  })

  it("types method input and response", async () => {
    const labels = await client.gmail.users.labels.list({ userId: "me" })
    expectTypeOf(labels.labels).toEqualTypeOf<GmailLabel[] | undefined>()
    await client.gmail.users.messages.modify({ id: "m1", requestBody: { addLabelIds: ["L1"] }, userId: "me" })
    // @ts-expect-error userId is required.
    await client.gmail.users.messages.modify({ id: "m1" })
  })

  it("checks access patterns", () => {
    defineConnection({
      access: {
        // @ts-expect-error unknown method.
        server: { write: ["gmail.users.messages.explode"] },
      },
      provider: google({ clientId: "id", clientSecret: "secret" }),
      scopes: [],
    })
    defineConnection({
      access: { server: { write: ["gmail.users.messages.*", "fetch"] } },
      provider: google({ clientId: "id", clientSecret: "secret" }),
      scopes: [],
    })
  })

  it("rejects unknown API selections", () => {
    defineConnection({
      // @ts-expect-error unknown method.
      api: { gmail: ["users.nothing"] },
      provider: google({ clientId: "id", clientSecret: "secret" }),
      scopes: [],
    })
  })
})
