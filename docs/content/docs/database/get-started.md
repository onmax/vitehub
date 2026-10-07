---

title: Query your first Database
description: Install Database, define a schema, apply the first migration, and query it.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Database gives server code a typed Drizzle client for a discovered schema. This
tutorial creates one SQLite table, applies its first migration, and reads it
from an H3 route.

::note
You need Node.js 24.15 or newer, `pnpm`, and an existing Vite server app. The
local SQLite store is for development. Read [Hosts](/docs/database/hosts) before
choosing a hosted database.
::

::tutorial-step{title="Install"}
## Install

```bash [commands/install]
pnpm add @vite-hub/database drizzle-orm nitro
pnpm add -D @vite-hub/cli drizzle-kit vite
```

::

::tutorial-step{title="Configure"}
## Configure

```ts [vite.config.ts]
import { hubDb } from '@vite-hub/database/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [hubDb(), nitro() as never],
})
```

::

::tutorial-step{title="Define the schema"}
## Define the schema

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

```bash [commands/generate]
pnpm vitehub db generate
pnpm vitehub db migrate
```

Query it from server code:

```ts [server/api/notes.get.ts]
import { defineEventHandler } from 'h3'
import { useDatabase } from '@vite-hub/database/drizzle'

export default defineEventHandler(() => {
  const { db, schema } = useDatabase('default')
  return db.select().from(schema.notes)
})
```

::


::tutorial-step{title="Inspect migrations"}
## Generate and apply migrations

The Database integration adds the `db` commands to the ViteHub CLI. `vite-hub` includes the CLI. Direct package installations need `@vite-hub/cli`, as shown in the quick start. Run the commands from the project root:

```bash [commands/migrate]
pnpm vitehub db generate
pnpm vitehub db migrate
```

| Command | Effect |
| --- | --- |
| `vitehub db generate` | Refreshes the generated Drizzle config and creates migrations from your Database Definitions. Pass `--name <name>` to name the migration or `--custom` to create an empty migration. |
| `vitehub db migrate` | Refreshes the generated Drizzle config and applies pending migrations. |

Migrations go to a `migrations` directory next to each Database Definition file.
::

::tutorial-step{title="Query the table"}
## Query the table

Start Vite and call the route:

```bash [commands/request]
pnpm vite dev
curl http://localhost:5173/api/notes
```

The first response is an empty array. Insert a row from your application, then
call the route again to read it through the generated Drizzle client.

::
