---
title: Migrate from NuxtHub
description: Move a Nuxt application from NuxtHub KV, Blob, and Database to ViteHub, and see which NuxtHub features have no ViteHub equivalent.
navigation.order: 41.6
navigation.group: Frameworks
icon: i-lucide-arrow-right-left
---

Use this page to move a Nuxt application from NuxtHub (`@nuxthub/core` v0.10) to
ViteHub. For KV and Blob, the change is mostly imports and error handling.
Database needs more care: ViteHub supports SQLite only, and it tracks migrations
in a different table.

After the move, the same KV, Blob, and Database APIs are also available to
[Agents](/docs/agents) through [Capabilities](/docs/capabilities).

## Compare the features

| NuxtHub | ViteHub | Notes |
| --- | --- | --- |
| `kv` from `@nuxthub/kv` | `kv` from `vite-hub/kv` | Same method names. Methods return `[error, value]`. |
| `blob` from `@nuxthub/blob` | `blob` from `vite-hub/blob` | Same core methods. Methods return `[error, value]`. |
| `db` and `schema` from `@nuxthub/db` | `useDatabase()` from `vite-hub/database/drizzle` | Drizzle in both. ViteHub supports SQLite, libSQL, and Cloudflare D1. |
| `hub.db: 'postgresql'` or `'mysql'` | Not supported | Keep NuxtHub or Drizzle for these databases. |
| `hub.cache` | Nitro storage | `cachedEventHandler` and `defineCachedFunction` are Nitro APIs and keep working. |
| `handleUpload`, multipart helpers, `useUpload` | Not available | Use `blob.sign()` for direct uploads, or write the upload route. |
| `hosting` auto-detection | `preset` | You must select the host. |
| `.data/` | `.vitehub/data/` | Local development data does not move automatically. |
| Auto-imported `kv`, `blob`, `db` | Explicit imports | Add an import to each server file. |

NuxtHub v0.10 removed `hubAI()`, AutoRAG, Vectorize, and `hubBrowser()`.
ViteHub has no AI or Vectorize feature either. For browser work on Cloudflare,
read [Browser](/docs/server-primitives/browser).

## Replace the module

Remove `@nuxthub/core` and install ViteHub. `vite-hub` includes `drizzle-orm`
and `drizzle-kit`.

```bash [Terminal]
pnpm remove @nuxthub/core
pnpm add vite-hub
```

Replace the `hub` key with the ViteHub module and a
[deployment preset](/docs/frameworks-hosts#choose-a-preset). Each feature is off
until you enable it.

::code-group

```ts [Before: nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["@nuxthub/core"],
  hub: {
    db: "sqlite",
    kv: true,
    blob: true,
  },
})
```

```ts [After: nuxt.config.ts]
import viteHubNuxt from "vite-hub/nuxt"

export default defineNuxtConfig({
  modules: [
    [viteHubNuxt, { preset: "cloudflare", database: true, kv: true, blob: true }],
  ],
})
```

::

Read [Nuxt](/docs/frameworks-hosts/nuxt) for the other module behavior.

## Move KV calls

Import `kv` from `vite-hub/kv`. Each method returns an `[error, value]` tuple
instead of throwing, so check the error.

::code-group

```ts [Before: server/api/settings.get.ts]
export default defineEventHandler(async () => {
  return await kv.get("settings")
})
```

```ts [After: server/api/settings.get.ts]
import { kv } from "vite-hub/kv"

export default defineEventHandler(async () => {
  const [error, settings] = await kv.get("settings")
  if (error) throw error
  return settings
})
```

::

`get`, `set`, `has`, `del`, `keys`, and `clear` keep their names. `set` passes
its options, such as `ttl`, to the store driver, so TTL support depends on the
driver. Read [KV](/docs/server-primitives/kv) for named stores and paginated
`list()`.

## Move Blob calls

Import `blob` from `vite-hub/blob`. `put`, `get`, `head`, `list`, `del`, and
`serve` keep their names, and `put` accepts the same `contentType`, `prefix`,
`addRandomSuffix`, and `customMetadata` options. Each method returns an
`[error, value]` tuple.

::code-group

```ts [Before: server/routes/files/[...pathname].get.ts]
export default defineEventHandler(async (event) => {
  const { pathname } = getRouterParams(event)
  return blob.serve(event, pathname)
})
```

```ts [After: server/routes/files/[...pathname].get.ts]
import { blob } from "vite-hub/blob"

export default defineEventHandler(async (event) => {
  const { pathname } = getRouterParams(event)
  const [error, stream] = await blob.serve(event, pathname)
  if (error) throw error
  return stream
})
```

::

ViteHub has no `handleUpload()`, multipart helpers, or `useUpload()`
composable. Validate files with `ensureBlob()` and call `blob.put()` in your own
route, or sign a direct `PUT` upload with `blob.sign()`. To serve files without
a route of your own, set `blob: { serve: true }`. Read
[Blob](/docs/server-primitives/blob).

## Move the database

ViteHub uses Drizzle, so your table definitions do not change. Move them from
`server/db/schema.ts` into a Database Definition at
`server/databases/config.ts`.

```ts [server/databases/config.ts]
import { defineDatabase } from "vite-hub/database"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export default defineDatabase({
  schema: {
    users: sqliteTable("users", {
      id: integer("id").primaryKey(),
      name: text("name").notNull(),
    }),
  },
})
```

Replace the `@nuxthub/db` import with `useDatabase()`. Queries do not change.

::code-group

```ts [Before: server/api/users.get.ts]
import { db, schema } from "@nuxthub/db"

export default defineEventHandler(async () => {
  return await db.select().from(schema.users)
})
```

```ts [After: server/api/users.get.ts]
import { useDatabase } from "vite-hub/database/drizzle"

export default defineEventHandler(async () => {
  const { db, schema } = useDatabase("default")
  return await db.select().from(schema.users)
})
```

::

### Migrations

NuxtHub applies the SQL files in `server/db/migrations/` and records them in the
`_hub_migrations` table. ViteHub generates migrations next to the Database
Definition, in `server/databases/migrations/`. It applies them with drizzle-kit
for SQLite and libSQL, and with Wrangler for Cloudflare D1. Neither reads
`_hub_migrations`.

```bash [Terminal]
pnpm vitehub db generate
pnpm vitehub db migrate
```

For a database that already has your tables, back it up first. Then read the
first generated migration before you run `vitehub db migrate`, because it
creates every table in the schema. Use `vitehub db generate --custom` to write a
migration by hand. NuxtHub applied migrations during `nuxt dev` and
`nuxt build`. With ViteHub, run `vitehub db migrate` in your deployment
workflow. Read [Database](/docs/server-primitives/database).

## Keep the cache

`cachedEventHandler()` and `defineCachedFunction()` come from Nitro, not from
NuxtHub, so they keep working. NuxtHub `hub.cache` only selected the storage
driver for Nitro's `cache` mount. Without it, Nitro uses its default cache
storage. To keep a shared cache in production, set the mount in `nitro.storage`
and declare the host resource. On Cloudflare, ViteHub adds its own `KV` binding
next to the `CACHE` namespace that you declare.

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  nitro: {
    storage: {
      cache: { driver: "cloudflare-kv-binding", binding: "CACHE" },
    },
    cloudflare: {
      wrangler: {
        kv_namespaces: [{ binding: "CACHE", id: "<namespace-id>" }],
      },
    },
  },
})
```

## Deploy

ViteHub uses the same Cloudflare binding names as NuxtHub: `DB` for D1, `KV` for
Workers KV, and `BLOB` for R2. Existing resources keep their data when the
binding names match.

| Host | What changes |
| --- | --- |
| Cloudflare | Set `preset: "cloudflare"`. Run `pnpm vitehub provision run --provider cloudflare` to resolve the D1 database ID. |
| Vercel | Set `preset: "vercel"`. KV reads only `KV_REST_API_URL` and `KV_REST_API_TOKEN`. Rename `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Blob reads `BLOB_READ_WRITE_TOKEN`. |
| Node | Set `preset: "node"`. KV and Blob use the file system under `.vitehub/data/`. |

Netlify and Deno have their own presets. Read
[Frameworks and hosts](/docs/frameworks-hosts) for the default provider of each
feature.

## Verify the migration

1. Run `pnpm nuxt dev` and call one route for each feature you moved.
2. Run `pnpm nuxt build`. A feature that the preset cannot provide fails the build.
3. Run `pnpm vitehub inspect provider-output` and confirm the bindings and environment variables.

## Next steps

- Give an Agent the same data with the [KV](/docs/capabilities/kv), [Blob](/docs/capabilities/blob), and [Database](/docs/capabilities/db) Capabilities.
- Read [Server primitives](/docs/server-primitives) for Queue, Workflow, Schedule, Auth, and the other APIs that NuxtHub does not provide.
