---
title: Query your first Database
description: Install Database, define a schema, apply the first migration, and query it.
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/database drizzle-orm
pnpm add -D @vite-hub/cli drizzle-kit
```

### Configure

```ts [vite.config.ts]
import { hubDb } from '@vite-hub/database/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubDb()],
})
```

### Start using it

Define the schema in `src/database.ts`:

```ts [src/database.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export default defineDatabase({
  schema: {
    notes: sqliteTable('notes', {
      id: integer('id').primaryKey(),
      title: text('title').notNull(),
    }),
  },
})
```

Generate and apply the first migration:

```bash [Terminal]
pnpm vitehub db generate
pnpm vitehub db migrate
```

Query it from server code:

```ts [server/api/notes.get.ts]
import { useDatabase } from '@vite-hub/database/drizzle'

export default defineEventHandler(() => {
  const { db, schema } = useDatabase('default')
  return db.select().from(schema.notes)
})
```

::

## Generate and apply migrations

The Database integration adds the `db` commands to the ViteHub CLI. `vite-hub` includes the CLI. Direct package installations need `@vite-hub/cli`, as shown in the quick start. Run the commands from the project root:

```bash [Terminal]
pnpm vitehub db generate
pnpm vitehub db migrate
```

| Command | Effect |
| --- | --- |
| `vitehub db generate` | Refreshes the generated Drizzle config and creates migrations from your Database Definitions. Pass `--name <name>` to name the migration or `--custom` to create an empty migration. |
| `vitehub db migrate` | Refreshes the generated Drizzle config and applies pending migrations. |

Migrations go to a `migrations` directory next to each Database Definition file.
