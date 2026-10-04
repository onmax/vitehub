import { describe, expect, it } from "vitest"

import { createWorkspaceCollectionQuery } from "../src/collections/query.ts"

const raw = JSON.stringify([
  { authors: [{ name: "Ada" }], rank: 10, slug: "alpha" },
  { authors: [{ name: "Grace" }, { name: "Ada" }], rank: 2, slug: "beta" },
  { authors: [{ name: "Grace" }], rank: 1, slug: "gamma" },
])

describe("Workspace Collection query snapshots", () => {
  it("evaluates pages and detail from one snapshot without filesystem setup", async () => {
    const collection = await createWorkspaceCollectionQuery(raw, { path: "data/items.json" })
    const query = { facets: ["authors.name"], filters: { "authors.name": "Ada" }, limit: 1, select: ["slug"], sort: { field: "rank" } }
    const first = await collection.page({ query })
    const second = await collection.page({ query: { ...query, cursor: first.nextCursor! } })

    expect(first).toMatchObject({
      facets: { "authors.name": [{ count: 2, value: "Ada" }, { count: 1, value: "Grace" }] },
      items: [{ slug: "beta" }],
      total: 2,
    })
    expect(second).toMatchObject({ digest: first.digest, items: [{ slug: "alpha" }], nextCursor: null })
    expect(collection.get({ key: "authors.name", select: ["slug"], value: "Grace" }))
      .toEqual({ digest: first.digest, item: { slug: "beta" } })
  })

  it("rejects null filter values without throwing", async () => {
    const collection = await createWorkspaceCollectionQuery(JSON.stringify([{ title: "Guide" }]), { path: "data/items.json" })

    await expect(collection.page({ query: { filters: { title: null as never }, limit: 10 } }))
      .resolves.toMatchObject({ items: [{ title: "Guide" }], total: 1 })
  })

  it("uses the supplied revision digest and rejects cursors from another snapshot", async () => {
    const original = await createWorkspaceCollectionQuery(raw, { digest: "original", path: "data/items.json" })
    const changed = await createWorkspaceCollectionQuery(raw, { digest: "changed", path: "data/items.json" })
    const first = await original.page({ query: { limit: 1 } })

    expect(first.digest).toBe("original")
    await expect(changed.page({ query: { cursor: first.nextCursor!, limit: 1 } }))
      .rejects.toMatchObject({ code: "WORKSPACE_COLLECTION_CURSOR_INVALID", details: { reason: "stale" } })
    await expect(createWorkspaceCollectionQuery("{}", { path: "data/items.json" }))
      .rejects.toThrow("Workspace collection data/items.json must contain a JSON array.")
  })
})
