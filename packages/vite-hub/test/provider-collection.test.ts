import { expect, expectTypeOf, it, vi } from "vitest"
import * as v from "valibot"

import { defineCollection } from "../src/source.ts"
import type { CollectionSource, ProviderCollectionSource } from "../src/source.ts"

type Row = { id: string; count: number }
type Query = { tenant: string; count: number }
type QueryInput = { tenant: string; count: string }

const querySchema = v.object({ tenant: v.string(), count: v.pipe(v.string(), v.transform(Number)) })

it("preserves provider schemas, required query fields, and get-capable sources", async () => {
  const load = vi.fn(async ({ query }: { query: Query }) => ({
    items: [{ id: query.tenant, count: query.count }], nextCursor: null,
  }))
  const source: ProviderCollectionSource<Row, Query, QueryInput> = {
    pagination: "provider", querySchema, load,
    get: async key => ({ id: key, count: 2 }),
  }
  const collection = defineCollection({ source, route: false, transform: row => ({ ...row, count: row.count * 2 }) })
  expectTypeOf(collection.query).parameter(0).toEqualTypeOf<QueryInput | undefined>()
  expect(collection.querySchema).toBe(querySchema)
  expect(collection.route).toBe(false)
  await expect(collection.query({ tenant: "one", count: "3" }).all()).resolves.toEqual([{ id: "one", count: 6 }])
  expect(load).toHaveBeenCalledWith(expect.objectContaining({ query: { tenant: "one", count: 3 } }))
  await expect(collection.get!("one")).resolves.toEqual({ id: "one", count: 4 })
  await expect(collection.parseQuery({ tenant: ["invalid"], count: "3" })).rejects.toThrow()
})

it("preserves cursor sources with get adapters and required query fields", async () => {
  const source: CollectionSource<Row, Query, string, string, QueryInput> = {
    cursor: row => row.id,
    cursorSchema: v.string(), querySchema,
    load: async ({ query }) => [{ id: query.tenant, count: query.count }],
    get: async key => ({ id: key, count: 2 }),
  }
  const collection = defineCollection({ source })
  expectTypeOf(collection.query).parameter(0).toEqualTypeOf<QueryInput | undefined>()
  expectTypeOf(collection.all).returns.toEqualTypeOf<Promise<Row[]>>()
  await expect(collection.query({ tenant: "one", count: "3" }).all()).resolves.toEqual([{ id: "one", count: 3 }])
  await expect(collection.get!("one")).resolves.toEqual({ id: "one", count: 2 })
})

it("requires valid provider page results at the adapter boundary", () => {
  const invalidCursor = {
    pagination: "provider" as const,
    load: async () => ({ items: [{ id: "one", count: 1 }], nextCursor: 1 }),
  }
  // @ts-expect-error Provider continuation cursors must be strings or null.
  defineCollection({ source: invalidCursor })
  const invalidItems = { pagination: "provider" as const, load: async () => [{ id: "one", count: 1 }] }
  // @ts-expect-error Provider loaders return a page, not a cursor-managed array.
  defineCollection({ source: invalidItems })
  const source = {
    pagination: "provider" as const,
    load: async () => ({ items: [{ id: "one", count: 1 }], nextCursor: "" }),
  }
  const collection = defineCollection({ source })
  expectTypeOf(collection.all).returns.toEqualTypeOf<Promise<Row[]>>()
})


it("continues through empty opaque provider cursors and stops repeated cursors", async () => {
  const load = vi.fn(async ({ cursor }: { cursor?: string; query: object }) => ({
    items: [{ id: cursor === undefined ? "first" : "second", count: 1 }],
    nextCursor: cursor === undefined ? "" : null,
  }))
  const collection = defineCollection({ source: { pagination: "provider", load } })
  await expect(collection.all()).resolves.toEqual([{ id: "first", count: 1 }, { id: "second", count: 1 }])
  expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "" }))
  const repeating = defineCollection({ source: {
    pagination: "provider", load: async () => ({ items: [], nextCursor: "" }),
  } })
  await expect(repeating.all()).rejects.toThrow("repeated a pagination cursor")
})

it("appends large provider pages without argument spreading", async () => {
  const items = Array.from({ length: 150_000 }, (_, index) => ({ id: String(index) }))
  const collection = defineCollection({ source: {
    pagination: "provider", maxLimit: items.length,
    load: async () => ({ items, nextCursor: null }),
  } })
  await expect(collection.all({ limit: items.length })).resolves.toEqual(items)
})
