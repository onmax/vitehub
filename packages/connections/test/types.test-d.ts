import { describe, expectTypeOf, it } from "vitest"

import { defineConnection } from "../src/definition.ts"
import { google } from "../src/google.ts"
import { useConnection } from "../src/runtime/state.ts"

import type { GmailClassificationLabelFieldValue, GmailClassificationLabelValue, GmailLabel } from "../src/google.ts"
import type { ConnectionClient, ConnectionDefinition, ConnectionFetchInit } from "../src/types.ts"

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

declare global {
  interface ViteHubConnectionDefinitionModules {
    typeTest: { default: typeof connection }
  }
}

describe("Connection types", () => {
  it("declares only serializable fetch bodies", () => {
    expectTypeOf<Parameters<Client["fetch"]>[1]>().toEqualTypeOf<ConnectionFetchInit | undefined>()
    const text: ConnectionFetchInit = { body: "label=INBOX", method: "POST" }
    expectTypeOf(text.body).toEqualTypeOf<string | undefined>()
    // @ts-expect-error Encode form parameters to a string before dispatch.
    const form: ConnectionFetchInit = { body: new URLSearchParams() }
    // @ts-expect-error Multipart bodies cannot be persisted for approval replay.
    const multipart: ConnectionFetchInit = { body: new FormData() }
    expectTypeOf(form).toEqualTypeOf<ConnectionFetchInit>()
    expectTypeOf(multipart).toEqualTypeOf<ConnectionFetchInit>()
  })

  it("requires Gmail classification label identifiers in request bodies", () => {
    expectTypeOf<GmailClassificationLabelFieldValue>().toEqualTypeOf<{ fieldId: string, selection?: string }>()
    expectTypeOf<GmailClassificationLabelValue>().toEqualTypeOf<{ fields?: GmailClassificationLabelFieldValue[], labelId: string }>()
  })
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

  it("includes skipped writes when dry run may be enabled", async () => {
    const normal = useConnection("typeTest")
    const dryRun = useConnection("typeTest", { dryRun: true })
    const conditional = useConnection("typeTest", { dryRun: true as boolean })
    type NormalResult = Awaited<ReturnType<typeof normal.gmail.users.messages.modify>>
    expectTypeOf<Awaited<ReturnType<typeof dryRun.gmail.users.messages.modify>>>().toEqualTypeOf<NormalResult | undefined>()
    expectTypeOf<Awaited<ReturnType<typeof conditional.gmail.users.messages.modify>>>().toEqualTypeOf<NormalResult | undefined>()
    expectTypeOf<Awaited<ReturnType<typeof normal.gmail.users.labels.list>>>().toEqualTypeOf<Awaited<ReturnType<typeof client.gmail.users.labels.list>>>()
    const result = await dryRun.gmail.users.messages.modify({ id: "m1", userId: "me" })
    // @ts-expect-error A skipped write has no provider response.
    expectTypeOf(result.id).toBeString()
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
