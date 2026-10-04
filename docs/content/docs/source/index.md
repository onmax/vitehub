---
title: Source
navigation.title: Overview
description: Retrieve read-only files, records, and external resources through typed source loaders.
navigation.order: 1
icon: i-lucide-folder-input
---

::product-hero{tagline="Read-only files, records, and external resources through typed loaders. A definition is a plain object, so the same one feeds a route, Content, and a Workspace."}

```ts [server/api/docs.get.ts]
import { createSource } from 'vite-hub/source'
import { docs } from '../sources/docs'

export default defineEventHandler(async () => {
  const reader = createSource(docs)
  return reader.read('intro.md')
})
```

::

::product-feature{label="Loaders" title="Local files, GitHub, and MCP share one reader contract" to="/docs/source/configure" link-label="Configure Source loaders"}
`file()`, `markdown()`, and `glob()` read the local file system. `github()` retrieves repository content. `mcpResources()` reads MCP Resources. Each loader reaches its own origin, so Source has no provider configuration.

Register definitions by name only when callers need `useSource()`. Direct `createSource()` calls need no registry.

#code
```ts [server/sources.ts]
import { defineSources, registerSources } from 'vite-hub/source'
import { file } from 'vite-hub/source/file'
import { github } from 'vite-hub/source/github'

export const sources = defineSources({
  readme: file('README.md'),
  docs: github({
    repo: 'acme/docs',
    ref: 'main',
    root: 'docs',
    include: ['**/*.md'],
  }),
})

registerSources(sources)
```
::

::product-feature{label="Typed definitions" title="Keys, items, and metadata infer from the loader" to="/docs/source/configure#source-object-contract" link-label="Define a custom loader" reverse}
`defineSource()` takes a loader with `name`, `getKeys()`, and `getItem()`. The reader types follow from it, with no registry or global type map.

Add `resolveRevision()` to pin a mutable origin to one revision for the life of one reader.

#code
```ts [server/sources/articles.ts]
import { createSource, defineSource } from 'vite-hub/source'

const articles = defineSource({
  name: 'articles',
  async getKeys() {
    return ['article_123' as const]
  },
  async getItem(key: `article_${string}`) {
    return { key, data: { title: 'Source API' }, metadata: { version: 1 } }
  },
})

const reader = createSource(articles)
const article = await reader.get('article_123')
article.data.title
article.metadata.version
```
::

::product-feature{label="Caching" title="Cache a keyed reader with Nitro cache options" to="/docs/source/server-api#cache-a-reader" link-label="Cache and combine readers"}
`cachedSource()` wraps an existing keyed reader. Give each cache a name that identifies its origin and access scope.

`github()`, `mcpResources()`, and custom loaders also accept a `cache` policy with `maxAge`. `combineSources()` merges readers that can return the same key.

#code
```ts [server/recaps.ts]
import { cachedSource } from 'vite-hub/source/server'

function githubRecaps(rootDir: string) {
  return {
    async get(month: `${number}-${number}`) {
      return { month, rootDir }
    },
  }
}

const cachedRecaps = cachedSource(githubRecaps(process.cwd()), {
  name: 'recaps',
  maxAge: 60,
})

await cachedRecaps.get('2026-07')
```
::

::product-feature{label="Collections" title="A Drizzle table becomes a paginated GET route" to="/docs/source/server-api#expose-a-typed-collection" link-label="Expose a typed Collection" reverse}
A module in `server/collections` exports a typed read model. ViteHub generates its read-only GET route and keeps the keyset cursor opaque. `transform()` keeps private columns out of the response.

Vue code reads the route with `useCollection()` and loads the next page with `loadMore()`.

#code
```ts [server/collections/articles.ts]
import { useDatabase } from 'vite-hub/database/drizzle'
import { defineCollection, table } from 'vite-hub/source'

const { db, schema } = useDatabase('default')

export const articles = defineCollection({
  source: table({
    db,
    table: schema.articles,
    orderBy: {
      column: schema.articles.createdAt,
      direction: 'desc',
      tieBreaker: schema.articles.id,
    },
  }),
  transform: article => ({ id: article.id, title: article.title }),
})
```

```vue [app/pages/articles.vue]
<script setup lang="ts">
const { items, pending, error, hasMore, loadMore } = useCollection('articles')
</script>
```
::

::product-feature{label="Access" title="The route checks Auth before it loads rows" to="/docs/source/server-api#protect-a-collection" link-label="Protect a Collection"}
Without `authorize`, the transformed shape is public. `authorize: true` requires a signed-in [Auth](/docs/auth) session. A callback returns `true`, `false`, or a `Response`.

A request without a session gets `401`, and `false` gets `403`. The client receives a `CollectionAccessError` with that status.

#code
```ts [server/collections/meals.ts]
export const meals = defineCollection({
  source: table({ /* ... */ }),
  authorize: ({ user }) => user.role === 'owner',
  transform: meal => ({ id: meal.id, calories: meal.calories }),
})
```

```ts
import { CollectionAccessError } from 'vite-hub/source/client'

const { error } = useCollection('meals')
const signedOut = computed(() => error.value instanceof CollectionAccessError && error.value.status === 401)
```
::

::product-feature{label="Related primitives" title="Content parses it, Workspace mounts it" to="/docs/workspace/configure#source-binding-options" link-label="Bind a Source in a Workspace" reverse}
Pass the same definition to [Content](/docs/content) for parsed documents and search, or bind it in a [Workspace](/docs/workspace) for a mutable file tree. Source keeps retrieval. Each consumer owns its reader lifecycle.

Source has no Agent Capability. Bind it to a Workspace, then attach `workspaceShell()`.

#code
```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { docs } from './sources/docs'

export const content = defineContent({ source: docs })
```

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
