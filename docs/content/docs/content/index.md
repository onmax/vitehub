---
title: Content
navigation.title: Overview
description: Parse, query, search, and serve Source content with Comark Content.
navigation.order: 1
icon: i-lucide-file-text
---

::product-hero{providers="Node SQLite, SQLite WASM" tagline="Parsed Markdown, JSON, YAML, and media from Sources, with navigation and search, served from one generated route on every preset."}
  :::code-group
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

  ```ts [Route]
  import { content } from '../content'

  export default defineEventHandler(async () => {
    return {
      page: await content.get('/guide'),
      navigation: await content.navigation(['docs']),
      results: await content.search(['docs'], 'runtime'),
    }
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

::product-flow{caption="Server code and the client read the same parsed index through one Definition."}
  :::product-flow-step{label="Source" detail="glob() · defineSource() · contentSource()"}
  :::
  :::product-flow-step{label="Definition" detail="defineContent() in server/content.ts"}
  :::
  :::product-flow-step{label="Parse and index" detail="content.init() · sqlite-full-text-search" loop}
  :::
  :::product-flow-step{label="Query or serve" detail="content.get() · content.search() · /api/content/**"}
  :::
::

::product-features
  :::product-feature-item{title="One Source definition feeds Content and direct reads" icon="i-lucide-folder-input" to="/docs/content/configure"}
  Each named Source in `defineContent()` becomes one Comark instance.
  :::

  :::product-feature-item{title="Documents, navigation, and search from server code" icon="i-lucide-code-2" to="/docs/content/server-api"}
  `content.get()`, `content.navigation()`, and `content.search()` run in server code.
  :::

  :::product-feature-item{title="The search index lives in SQLite" icon="i-lucide-search" to="/docs/content/configure#providers"}
  The `sqlite-full-text-search` plugin uses Node SQLite or SQLite WASM.
  :::

  :::product-feature-item{title="The client reads the generated route directly" icon="i-lucide-radio" to="/docs/content/server-api#client"}
  `createContentClient()` calls `/api/content/**`, served by the Vite plugin or Nuxt module.
  :::

  :::product-feature-item{title="Give an Agent the files through Workspace" icon="i-lucide-bot" to="/docs/workspace/agent-capability"}
  Bind the same Source to a Workspace and attach `workspaceShell()`.
  :::

  :::product-feature-item{title="Not for raw records or mutable trees" icon="i-lucide-git-branch" to="/docs/source"}
  Use Source for raw records and Workspace for mutable file trees.
  :::
::
