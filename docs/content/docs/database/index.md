---
title: Database
navigation.title: Overview
description: Define relational data with Drizzle and query it through generated ViteHub imports.
navigation.order: 1
icon: i-lucide-database
---

::product-hero{tagline="Relational tables defined with Drizzle and queried through one typed client on local SQLite, hosted libSQL, and Cloudflare D1."}
  :::code-group
  ```ts [Route]
  import { useDatabase } from '@vite-hub/database/drizzle'

  export default defineEventHandler(() => {
    const { db, schema } = useDatabase('default')
    return db.select().from(schema.notes)
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

::product-features
  :::product-feature-item{title="The Drizzle schema is the source of truth" icon="i-lucide-code-2" to="/docs/database/configure" link-label="Configure Database"}
  ViteHub discovers the Definition in `src/database.ts` or `server/databases/config.ts` and generates the Drizzle artifacts and migration config.
  :::

  :::product-feature-item{title="Generate migrations from the Definition" icon="i-lucide-terminal" to="/docs/database/get-started" link-label="Database get started"}
  `vitehub db generate` writes migrations next to each Definition file, and `vitehub db migrate` applies the pending ones.
  :::

  :::product-feature-item{title="One typed client for each database name" icon="i-lucide-database" to="/docs/database/server-api" link-label="Database server API"}
  `useDatabase()` returns the Drizzle client and schema for `default` or a Named Database, each with its own connection.
  :::

  :::product-feature-item{title="Guarded SQL for an Agent" icon="i-lucide-bot" to="/docs/database/agent-capability" link-label="Database Agent capability"}
  The Database Capability gives an Agent `db_query` and `db_schema`, and in write mode `db_exec`, one statement per call.
  :::

  :::product-feature-item{title="Change the connection, keep the route" icon="i-lucide-cloud-cog" to="/docs/database/hosts" link-label="Database hosts"}
  Select hosted libSQL in the Vite integration or set `cloudflare` options for D1, and route code keeps its Drizzle imports.
  :::

  :::product-feature-item{title="Not for small values, files, or file trees" icon="i-lucide-git-branch" to="/docs/kv" link-label="Compare KV"}
  Use KV for small values by key, Blob for files, and Workspace for file trees.
  :::
::
