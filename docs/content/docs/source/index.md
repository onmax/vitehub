---
title: Source
navigation.title: Overview
description: Retrieve read-only files, records, and external resources through typed source loaders.
navigation.order: 1
icon: i-lucide-folder-input
---

::product-hero{tagline="Typed read-only loaders for files, GitHub, and MCP Resources, defined once and shared by routes, Content, and Workspaces."}
  :::code-group
  ```ts [Route]
  import { createSource } from 'vite-hub/source'
  import { docs } from '../sources/docs'

  export default defineEventHandler(async () => {
    const reader = createSource(docs)
    return reader.read('intro.md')
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

  ```ts [Collection]
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

::product-features
  :::product-feature-item{title="Local files, GitHub, and MCP share one reader" icon="i-lucide-files" to="/docs/source/configure" link-label="Configure Source"}
  `file()`, `markdown()`, `glob()`, `github()`, and `mcpResources()` each reach their own origin, so Source has no provider configuration.
  :::

  :::product-feature-item{title="Keys, items, and metadata infer from the loader" icon="i-lucide-code-2" to="/docs/source/configure#source-object-contract" link-label="Source object contract"}
  `defineSource()` takes `name`, `getKeys()`, and `getItem()`, and reader types follow with no registry or global type map.
  :::

  :::product-feature-item{title="Cache a keyed reader with Nitro cache options" icon="i-lucide-box" to="/docs/source/server-api#cache-a-reader" link-label="Cache and combine readers"}
  `cachedSource()` wraps a keyed reader under a named cache, and `combineSources()` merges readers that can return the same key.
  :::

  :::product-feature-item{title="A Drizzle table becomes a paginated GET route" icon="i-lucide-database" to="/docs/source/server-api#expose-a-typed-collection" link-label="Expose a typed Collection"}
  ViteHub turns a module in `server/collections` into a read-only GET route with an opaque cursor, and Vue reads it with `useCollection()`.
  :::

  :::product-feature-item{title="The route checks Auth before it loads rows" icon="i-lucide-shield-check" to="/docs/source/server-api#protect-a-collection" link-label="Protect a Collection"}
  `authorize` requires an Auth session or runs a callback, and the client gets a `CollectionAccessError` with `401` or `403`.
  :::

  :::product-feature-item{title="Not for parsed documents or mutable trees" icon="i-lucide-git-branch" to="/docs/content" link-label="Compare Content"}
  Use Content for parsed documents and search, and bind the Source in a Workspace for a mutable tree and Agent tools.
  :::
::
