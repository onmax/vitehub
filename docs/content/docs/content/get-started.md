---
title: Read your first Content document
description: Install Comark Content, define server/content.ts, and read the first document.
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

## Quick start

::steps{level="3"}

### Install

`comark-content` is an optional peer dependency of `vite-hub`. Install it with the framework package.

```bash [Terminal]
pnpm add vite-hub comark-content
```

### Configure

Content needs no extra configuration key. The `vitehub()` Vite plugin and the Nuxt module discover `server/content.ts` and serve its exported `content` instance at `/api/content/**`. Do not add a framework route or a `fetch()` wrapper.

### Start using it

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

Read it from server code:

```ts [server/api/guide.get.ts]
import { content } from '../content'

export default defineEventHandler(async () => {
  return await content.get('/guide')
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

Read [Server API](/docs/content/server-api) for every Content method.
