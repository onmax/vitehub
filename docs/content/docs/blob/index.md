---
title: Blob
navigation.title: Overview
description: Store uploads, generated files, binary objects, and metadata with one object-storage API.
navigation.order: 1
icon: i-lucide-files
---

Use Blob for uploads, generated media, PDFs, exports, and other objects that don't need a file tree.

Use [Workspace](/docs/workspace) when files need paths, snapshots, diffs, Source sync, or agent access. A Blob Store only keeps objects and their metadata.

This server route writes one object to the Default Blob Store:

```ts [server/api/files.post.ts]
import { blob } from '@vite-hub/blob'

export default defineEventHandler(async () => {
  const [error, object] = await blob.put('hello.txt', 'Hello from ViteHub')
  if (error) throw error
  return object
})
```

## Connect Blob to Agents

Direct Blob access is for server code. To let a model inspect or edit scoped object storage, attach the [Blob Capability](/docs/blob/agent-capability).

Give a Blob Capability the narrowest useful key prefix and configure write access deliberately. Use Workspace when the model needs a file tree, diffs, snapshots, or Source-backed context.
