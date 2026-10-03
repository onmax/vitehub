---
title: Source
navigation.title: Overview
description: Retrieve read-only files, records, and external resources through typed source loaders.
navigation.order: 1
icon: i-lucide-folder-input
---

::product-hero{providers="Local files, Glob, GitHub, MCP Resources, Custom" tagline="Typed read-only loaders for files, GitHub, and MCP Resources, defined once and shared by routes, Content, and Workspaces."}
  :::code-group
  ```ts [Collection]
  import { eq } from 'drizzle-orm'
  import * as v from 'valibot'
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
      defaultLimit: 25,
      maxLimit: 100,
      querySchema: v.object({ author: v.optional(v.string()) }),
      where: ({ query, table }) => query.author
        ? eq(table.author, query.author)
        : undefined,
    }),
    transform: article => ({ id: article.id, title: article.title }),
  })
  ```

  ```ts [Definition]
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

  ```vue [Client]
  <script setup lang="ts">
  const author = ref<string>()
  const { items, pending, error, hasMore, loadMore } = useCollection('articles', {
    filter: computed(() => ({ author: author.value })),
  })
  </script>
  ```

  ```ts [Workspace]
  import { defineWorkspace } from 'vite-hub/workspace'
  import { docs } from '../sources/docs'

  export default defineWorkspace({
    sources: {
      docs: { source: docs, mount: 'docs', materialize: 'lazy' },
    },
  })
  ```
  :::
::

::product-flow{caption="Routes, Content, and Workspaces read the same typed items from one loader."}
  :::product-flow-step{label="Loader" detail="file() · glob() · github() · mcpResources()"}
  :::
  :::product-flow-step{label="Reader" detail="createSource(docs)"}
  :::
  :::product-flow-step{label="Cache" detail="cachedSource(reader, options)"}
  :::
  :::product-flow-step{label="Read or Collection" detail="source.read() · server/collections"}
  :::
::

::product-features
  :::product-feature-item{title="Local files, GitHub, and MCP share one reader" icon="i-lucide-files" to="/docs/source/configure"}
  `file()`, `markdown()`, `glob()`, `github()`, and `mcpResources()`, with no provider configuration.
  :::

  :::product-feature-item{title="Keys, items, and metadata infer from the loader" icon="i-lucide-code-2" to="/docs/source/configure#source-object-contract"}
  `defineSource()` needs `name`, `getKeys()`, and `getItem()`; no type registry.
  :::

  :::product-feature-item{title="Cache a keyed reader with Nitro cache options" icon="i-lucide-box" to="/docs/source/server-api#cache-a-reader"}
  `cachedSource()` caches a reader; `combineSources()` merges readers by key.
  :::

  :::product-feature-item{title="A Drizzle table becomes a paginated GET route" icon="i-lucide-database" to="/docs/source/server-api#expose-a-typed-collection"}
  Each `server/collections` module gets a cursor-paged GET route and `useCollection()`.
  :::

  :::product-feature-item{title="The route checks Auth before it loads rows" icon="i-lucide-shield-check" to="/docs/source/server-api#protect-a-collection"}
  `authorize` checks the session; the client gets `401` or `403`.
  :::

  :::product-feature-item{title="Not for parsed documents or mutable trees" icon="i-lucide-git-branch" to="/docs/content"}
  Use Content for parsed documents and Workspace for mutable trees.
  :::
::
