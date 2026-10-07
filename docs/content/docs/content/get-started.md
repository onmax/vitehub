---

title: Read your first Content document
description: Install Comark Content, define server/content.ts, and read the first document.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Content turns Source files into parsed documents, navigation, and search. This
tutorial reads one Markdown file from a local Source through a generated route.

::note
You need Node.js 24.15 or newer, `pnpm`, and an existing Vite server app. The
SQLite search plugin in this example writes local state. Choose a hosted
database before deploying more than one process.
::

::tutorial-step{title="Install"}
## Install

`comark-content` is an optional peer dependency of `vite-hub`. Install it with the framework package.

```bash [commands/install]
pnpm add vite-hub comark-content nitro h3
pnpm add -D vite
```

::

::tutorial-step{title="Configure"}
## Configure

Content needs no extra configuration key. The `vitehub()` Vite plugin and the Nuxt module discover `server/content.ts` and serve its exported `content` instance at `/api/content/**`. Do not add a framework route or a `fetch()` wrapper.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node' }), nitro() as never],
})
```

::

::tutorial-step{title="Define and read Content"}
## Define and read Content

```ts [server/content.ts]
import sqlite from 'comark-content/database/sqlite-node'
import sqliteFullTextSearch from 'comark-content/plugins/sqlite-full-text-search'
import { defineContent } from 'vite-hub/content'
import { glob } from 'vite-hub/source/glob'

export const content = defineContent({
  plugins: [sqliteFullTextSearch({ database: sqlite() })],
  sources: {
    docs: glob({ cwd: 'docs', include: '**/*.md' }),
  },
})
```

Add the document that the route will read:

```md [docs/intro.md]
# Hello from Content

This page came from a local Source.
```

Read it from server code:

```ts [server/api/guide.get.ts]
import { defineEventHandler } from 'h3'
import { content } from '../content'

export default defineEventHandler(async () => {
  return await content.get('/intro')
})
```

Or read the generated route from the client:

```ts [app/utils/content.ts]
import searchClient from 'comark-content/plugins/sqlite-full-text-search/client'
import { createContentClient } from 'vite-hub/content/client'

export const content = createContentClient({
  plugins: [searchClient()],
})

await content.search('runtime', { instances: ['docs'] })
```

::

::tutorial-step{title="Read one document"}
## Read one document

Start Vite and read the generated Content route:

```bash [commands/request]
pnpm vite dev
curl http://localhost:5173/api/guide
```

The response contains the parsed `Hello from Content` document. Read
[Server API](/docs/content/server-api) for every Content method.

::
