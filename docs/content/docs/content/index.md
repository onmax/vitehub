---
title: Content
navigation.title: Overview
description: Parse, query, search, and serve Source content with Comark Content.
navigation.order: 1
icon: i-lucide-file-text
---

::product-hero{tagline="Parsed Markdown, JSON, YAML, and media from Sources, with navigation and search, served from one generated route on every preset."}
  :::code-group
  ```ts [Route]
  import { content } from '../content'

  export default defineEventHandler(async () => {
    return await content.get('/guide')
  })
  ```

  ```ts [Definition]
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

  ```ts [Client]
  import searchClient from 'comark-content/plugins/sqlite-full-text-search/client'
  import { createContentClient } from 'vite-hub/content/client'

  export const content = createContentClient({
    plugins: [searchClient()],
  })

  await content.search('runtime', { instances: ['docs'] })
  ```
  :::
::

::product-features
  :::product-feature-item{title="One Source definition feeds Content and direct reads" icon="i-lucide-folder-input" to="/docs/content/configure" link-label="Configure Content"}
  `defineContent()` takes one `source` or named `sources`, and each name becomes one Comark Content instance.
  :::

  :::product-feature-item{title="Documents, navigation, and search from server code" icon="i-lucide-code-2" to="/docs/content/server-api" link-label="Content server API"}
  `content.get()` returns a parsed document by path, `content.navigation()` builds one tree, and `content.search()` runs full-text search.
  :::

  :::product-feature-item{title="The search index lives in SQLite" icon="i-lucide-search" to="/docs/content/configure#providers" link-label="Content database providers"}
  The `sqlite-full-text-search` plugin keeps the index in a Node SQLite or SQLite WASM database.
  :::

  :::product-feature-item{title="The client reads the generated route directly" icon="i-lucide-radio" to="/docs/content/server-api#client" link-label="Content client"}
  The Vite plugin and Nuxt module serve the `content` export at `/api/content/**`, and `createContentClient()` calls it.
  :::

  :::product-feature-item{title="Give an Agent the files through Workspace" icon="i-lucide-bot" to="/docs/workspace/agent-capability" link-label="Workspace Agent capability"}
  Content has no Agent Capability, so bind the same Source to a Workspace and attach `workspaceShell()`.
  :::

  :::product-feature-item{title="Not for raw records or mutable trees" icon="i-lucide-git-branch" to="/docs/source" link-label="Compare Source"}
  Use Source for raw files and records, Collections for paginated read models, and Workspace for a mutable file tree.
  :::
::
