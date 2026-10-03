---
title: Content
navigation.title: Overview
description: Parse, query, search, and serve Source content with Comark Content.
navigation.order: 1
icon: i-lucide-file-text
---

::product-hero{tagline="Markdown, JSON, YAML, and media from Sources become parsed documents with navigation, queries, and full-text search. ViteHub serves them from one generated route on every preset."}

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

::

::product-feature{label="Sources" title="One Source definition feeds Content and direct reads" to="/docs/content/configure" link-label="Configure Content Sources"}
`defineContent()` takes one `source` or a map of named `sources`. Each name becomes one Comark Content instance. A Source definition, a registered Source name, a reader factory, or a native Comark Source all work.

Content opens a new reader for each load, so overlapping refreshes keep their own revisions.

#code
```ts [server/sources/docs.ts]
import { glob } from 'vite-hub/source/glob'

export const docs = glob({ cwd: 'docs', include: '**/*.md' })
```

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { docs } from './sources/docs'

export const content = defineContent({ source: docs })
```
::

::product-feature{label="Server API" title="Read documents, navigation, and search results from server code" to="/docs/content/server-api" link-label="Read the Content server API" reverse}
`content.get()` returns one parsed document by public path. `content.navigation()` builds one tree across instances. `content.search()` runs full-text search.

Search needs the `sqlite-full-text-search` plugin and a Node SQLite or SQLite WASM database. Comark Content keeps the index in that database.

#code
```ts [server/api/guide.get.ts]
import { content } from '../content'

export default defineEventHandler(async () => {
  return await content.get('/guide')
})
```

```ts
await content.get('/guide')
await content.navigation(['docs'])
await content.search(['docs'], 'runtime')
```
::

::product-feature{label="Client" title="The client reads the generated route with no wrapper" to="/docs/content/server-api#client" link-label="Use the Content client"}
The `vitehub()` Vite plugin and the Nuxt module discover `server/content.ts` and serve its `content` export at `/api/content/**`. Do not add a framework route or a `fetch()` wrapper.

`createContentClient()` calls that route. Client plugins add the methods that match server plugins, such as `search()`.

#code
```ts [app/utils/content.ts]
import searchClient from 'comark-content/plugins/sqlite-full-text-search/client'
import { createContentClient } from 'vite-hub/content/client'

export const content = createContentClient({
  plugins: [searchClient()],
})

await content.search('runtime', { instances: ['docs'] })
```
::

::product-feature{label="Related primitives" title="Source retrieves, Content parses, Workspace edits" to="/docs/workspace/agent-capability" link-label="Give an Agent the same files" reverse}
Use [Source](/docs/source) for raw files and records, and [Collections](/docs/source/server-api#expose-a-typed-collection) for paginated read models. Use [Workspace](/docs/workspace) for a mutable file tree. Its search covers every visible file, including generated and non-content files.

Content has no Agent Capability. Bind the same Source to a Workspace and attach `workspaceShell()` to give an Agent the files.

#code
```ts [server/workspaces/docs.ts]
import { defineWorkspace } from 'vite-hub/workspace'
import { docs } from '../sources/docs'

export default defineWorkspace({
  sources: {
    docs: { source: docs, mount: 'docs', materialize: 'lazy' },
  },
})
```
::
