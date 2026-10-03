---
title: Database
navigation.title: Overview
description: Define relational data with Drizzle and query it through generated ViteHub imports.
navigation.order: 1
icon: i-lucide-database
---

::product-hero{providers="SQLite, libSQL, Cloudflare D1" tagline="Relational tables defined with Drizzle and queried through one typed client on local SQLite, hosted libSQL, and Cloudflare D1."}
  :::code-group
  ```ts [Route]
  import { useDatabase } from '@vite-hub/database/drizzle'

  export default defineEventHandler(async (event) => {
    const { title, body } = await readBody<{ title: string, body: string }>(event)

    const app = useDatabase('default')
    const [note] = await app.db.insert(app.schema.notes).values({ title, body }).returning()

    // A Named Database has its own typed client and connection.
    const analytics = useDatabase('analytics')
    await analytics.db.insert(analytics.schema.events).values({ name: 'note.created' })

    return note
  })
  ```

  ```ts [Definition]
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

  ```ts [Agent]
  import { defineAgent } from 'vite-hub/agent'
  import { db } from 'vite-hub/agent/capabilities'

  export default defineAgent({
    driver: { model: 'openai/gpt-5.1-mini' },
    capabilities: [
      db({ mode: 'write', policy: 'require-approval' }),
    ],
  })
  ```

  ```bash [CLI]
  pnpm vitehub db generate
  pnpm vitehub db migrate
  ```
  :::
::

::product-flow{caption="useDatabase(name) returns a typed Drizzle client and schema for each database."}
  :::product-flow-step{label="Route" detail="useDatabase('default')"}
  :::
  :::product-flow-step{label="Definition" detail="defineDatabase({ schema })"}
  :::
  :::product-flow-step{label="Drizzle client" detail="{ db, schema }"}
  :::
  :::product-flow-step{label="Connection" detail="SQLite · libSQL · Cloudflare D1"}
  :::
  :::product-flow-step{label="Typed rows" detail="db.select().from(schema.notes)"}
  :::
::

::product-features
  :::product-feature-item{title="The Drizzle schema is the source of truth" icon="i-lucide-code-2" to="/docs/database/configure"}
  ViteHub discovers `src/database.ts` and generates the Drizzle artifacts.
  :::

  :::product-feature-item{title="Generate migrations from the Definition" icon="i-lucide-terminal" to="/docs/database/get-started"}
  `vitehub db generate` writes migrations; `vitehub db migrate` applies them.
  :::

  :::product-feature-item{title="One typed client for each database name" icon="i-lucide-database" to="/docs/database/server-api"}
  `useDatabase()` returns `db` and `schema` for `default` or a Named Database.
  :::

  :::product-feature-item{title="Guarded SQL for an Agent" icon="i-lucide-bot" to="/docs/database/agent-capability"}
  `db_query` and `db_schema`, plus `db_exec` in write mode.
  :::

  :::product-feature-item{title="Change the connection, keep the route" icon="i-lucide-cloud-cog" to="/docs/database/hosts"}
  Local SQLite, hosted libSQL, or Cloudflare D1, with the same imports.
  :::

  :::product-feature-item{title="Not for small values, files, or file trees" icon="i-lucide-git-branch" to="/docs/kv"}
  Use KV for values, Blob for files, Workspace for file trees.
  :::
::
