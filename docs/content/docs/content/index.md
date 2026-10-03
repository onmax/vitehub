---
title: Content
navigation.title: Overview
description: Parse, query, search, and serve Source content with Comark Content.
navigation.order: 1
icon: i-lucide-file-text
---

Use Content when Markdown, JSON, YAML, or media from one or more Sources should become a parsed runtime API with documents, navigation, queries, and full-text search.

ViteHub owns Source retrieval, the generated `/api/content/**` route, and the Source adapter. [Comark Content](https://content.comark.dev) owns document parsing, manifests, navigation, cache entries, SQL queries, full-text search, and the client contract. Content works without Agents.

::tip
Choose the primitive by what the caller needs:

- [Source](/docs/source): read-only retrieval of raw files and records.
- Content: parsed documents with navigation, queries, and full-text search over Source content.
- [Workspace](/docs/workspace): a mutable file tree. Its filesystem search covers every visible file, including generated and non-content files.
- [Collections](/docs/source/server-api#expose-a-typed-collection): typed, paginated application read models over records.
::

This `server/content.ts` file serves Markdown from one Source with full-text search:

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

## Connect Content to Agents

Content has no Agent Capability. To give an Agent the same files, bind the Source to a [Workspace](/docs/workspace) and attach the [Workspace Shell Capability](/docs/workspace/agent-capability).
