---
title: Realtime collaboration
navigation.title: Overview
description: Sync collaborative Markdown through Workspace, choose a room authority, and create durable checkpoints.
navigation.order: 1
icon: i-lucide-radio
---

Realtime connects TipTap editors through Yjs while keeping canonical Markdown in
a [Workspace](/docs/workspace). Use it when several clients
need to edit the same Workspace document and see presence, connection state, and
external file changes.

Use [Workspace](/docs/workspace) alone when one writer changes files through
server code or Agent tools. Use [Channels](/docs/channels) to send outbound
messages, not to sync editor state.

A Realtime Definition names the Workspace that keeps the canonical document:

```ts [server/realtime/docs.ts]
import { defineRealtime } from 'vite-hub/realtime'

export default defineRealtime({
  document: { workspace: 'docs' },
  history: {
    checkpoint: { message: 'Save collaborative document' },
  },
})
```

## Next steps

- [Get started](/docs/realtime/get-started): install Realtime, define a room, and connect a TipTap editor.
- [Configure](/docs/realtime/configure): choose a room authority and check message and room size limits.
- [Server API](/docs/realtime/server-api): public imports, generated output, and durable checkpoints.

## Related

- [Workspace](/docs/workspace)
- [Auth](/docs/auth)
- [File conventions](/docs/reference/file-conventions)
- [Config options](/docs/reference/config-options)
- [Generated files](/docs/development/generated-files)
