---
title: Source
navigation.title: Overview
description: Retrieve read-only files, records, and external resources through typed source loaders.
navigation.order: 1
icon: i-lucide-folder-input
---

Use Source when server code needs read-only content from local files, globs, Markdown, GitHub, MCP resources, or a custom loader. A Source definition is a plain object. Open it with `createSource()` and read keys, items, and metadata with inferred types.

Source works without Agents and without a Vite plugin. The same definition can feed [Content](/docs/content), a [Workspace](/docs/workspace) Source Binding, or a typed Collection route.

::tip
Choose the primitive by what you do with the content:

- Source: read-only retrieval of files and records from an origin. No paths of its own, no writes.
- [Workspace](/docs/workspace): mutable file-tree state with paths, rules, sync, snapshots, diffs, and Agent access.
- [Content](/docs/content): parsed Markdown, JSON, or YAML documents with navigation, queries, and full-text search.
- [Collection](/docs/source/server-api#expose-a-typed-collection): a typed, paginated HTTP read model over records.
::

## Parse and serve content

Use [Content](/docs/content) when Source output should become parsed documents, navigation, queries, or full-text search. Pass the definition directly:

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { docs } from './sources/docs'

export const content = defineContent({ source: docs })
```

Content opens a new reader for each refresh. Each load keeps its own revision, including when refreshes overlap. Pass a definition when Content should own that lifecycle. An explicitly supplied reader retains its caller-owned lifecycle.

## Use Sources with Workspace

Use Workspace Source Bindings when retrieved content must appear inside a persistent Workspace file tree.

```ts [server/workspaces/docs.ts]
import { defineWorkspace } from 'vite-hub/workspace'
import { docs } from '../sources/docs'

export default defineWorkspace({
  sources: {
    docs: {
      source: docs,
      mount: 'docs',
      materialize: 'lazy',
    },
  },
})
```

Workspace owns placement, materialization, sync, and access rules. The Source still owns retrieval. The binding above reuses the same definition as direct reads and Content. The key `intro.md` appears at `docs/intro.md` in the Workspace.

`vite-hub/workspace` also exports `file()`, `glob()`, `github()`, `markdown()`, `mcpResources()`, `fetch()`, and `custom()`. These helpers combine loader options with Workspace binding options.

## Connect Source to Agents

Source has no Agent Capability of its own. Bind the Source to a [Workspace](/docs/workspace), then attach the [Workspace Shell Capability](/docs/workspace/agent-capability) so the Agent can inspect the mounted files. Workspace rules and access scopes decide what the Agent sees.

## Next steps

- [Get started](/docs/source/get-started): install ViteHub and read a first Source.
- [Configure](/docs/source/configure): loader options, cache policy, and custom loaders.
- [Server API](/docs/source/server-api): read, register, combine, and expose Sources as Collections.
- [Hosts](/docs/source/hosts): runtime requirements for each loader.
- [Limits and errors](/docs/source/limits-and-errors): path, symlink, cache, and Collection checks.
- Learn the shared model in [Workspace and Sources](/docs/getting-started/concepts/workspace-and-sources).
- Persist retrieved content through [Workspace](/docs/workspace).
- Parse and search documents with [Content](/docs/content).
- Expose Workspace content to Agents through [Workspace Shell](/docs/workspace/agent-capability).
