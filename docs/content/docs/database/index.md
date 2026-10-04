---
title: Database
navigation.title: Overview
description: Define relational data with Drizzle and query it through generated ViteHub imports.
navigation.order: 1
icon: i-lucide-database
---

::product-hero{tagline="Relational tables defined with Drizzle next to your server code, queried through one typed client. The same Definition runs on local SQLite, hosted libSQL, and Cloudflare D1."}

```ts [server/api/notes.get.ts]
import { useDatabase } from '@vite-hub/database/drizzle'

export default defineEventHandler(() => {
  const { db, schema } = useDatabase('default')
  return db.select().from(schema.notes)
})
```

::

::product-feature{label="Definition" title="The schema in code is the source of truth" to="/docs/database/configure" link-label="Define a database"}
A Database Definition holds the Drizzle tables. ViteHub discovers it from `src/database.ts` or `server/databases/config.ts`, then generates the Drizzle artifacts and the migration config.

`sqlite` is the only dialect, so local SQLite, hosted libSQL, and Cloudflare D1 take the same SQL.

#code
```ts [src/database.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export default defineDatabase({
  schema: {
    notes: sqliteTable('notes', {
      id: integer('id').primaryKey(),
      title: text('title').notNull(),
      body: text('body').notNull(),
    }),
  },
})
```
::

::product-feature{label="Migrations" title="Generate migrations from the Definition" to="/docs/database/get-started" link-label="Create the first migration" reverse}
The Database integration adds `db` commands to the ViteHub CLI. `generate` creates migrations from your Database Definitions. `migrate` applies the pending migrations.

Migrations go to a `migrations` directory next to each Definition file.

#code
```bash [Terminal]
pnpm vitehub db generate
pnpm vitehub db migrate
```
::

::product-feature{label="Server API" title="One typed client for each database name" to="/docs/database/server-api" link-label="Read the Database server API"}
`useDatabase()` returns the Drizzle client as `db` and the Definition schema as `schema`. Use `default` for the Default Database.

Add a Named Database when the app has a real data or deployment split. Each name gets its own client, schema, and connection.

#code
```ts [src/analytics.database.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

const events = sqliteTable('events', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
})

export default defineDatabase({
  name: 'analytics',
  schema: { events },
})
```

```ts [server/api/events.get.ts]
import { useDatabase } from '@vite-hub/database/drizzle'

export default defineEventHandler(() => {
  const { db, schema } = useDatabase('analytics')
  return db.select().from(schema.events)
})
```
::

::product-feature{label="Agent capability" title="Guarded SQL for an Agent, not a raw client" to="/docs/database/agent-capability" link-label="Give an Agent Database tools" reverse}
Attach the Database Capability to hand an Agent `db_query` for one read-only statement and `db_schema` for schema inspection. Write mode adds `db_exec` for one mutation with a rationale.

The guard rejects multi-statement input. DDL needs `schemaMode: 'write'`. Mutations can require approval.

#code
```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { db } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  capabilities: [
    db({ mode: 'write', policy: 'require-approval' }),
  ],
})
```
::

::product-feature{label="Hosts" title="Change the connection, keep the route" to="/docs/database/hosts" link-label="See host and provider notes"}
Select hosted libSQL in the Vite integration, or set `cloudflare` options for D1. Runtime Env declarations keep credentials out of the build output. Route code keeps the generated Drizzle imports.

Use [KV](/docs/kv) for small values by key, [Blob](/docs/blob) for files, and [Workspace](/docs/workspace) for file trees.

#code
```ts [vite.config.ts]
import { hubDb } from '@vite-hub/database/vite'
import { env, hubEnv } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubEnv(),
    hubDb({
      connection: {
        url: env({ source: env.source('TURSO_DATABASE_URL') }),
        authToken: env({ secret: true, source: env.source('TURSO_AUTH_TOKEN') }),
      },
    }),
  ],
})
```
::
