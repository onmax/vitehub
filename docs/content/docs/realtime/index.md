---
title: Realtime collaboration
navigation.title: Overview
description: Sync collaborative Markdown through Workspace, choose a room authority, and create durable checkpoints.
navigation.order: 1
icon: i-lucide-radio
---

::product-hero{tagline="Several TipTap editors edit one Workspace document through Yjs, with presence and connection state. The room authority runs in memory on Node or in Durable Objects on Cloudflare, and canonical Markdown stays in Workspace."}

```ts [server/realtime/docs.ts]
import { defineRealtime } from 'vite-hub/realtime'

export default defineRealtime({
  document: { workspace: 'docs' },
  history: {
    checkpoint: { message: 'Save collaborative document' },
  },
})
```

::

::product-feature{label="Editor" title="One composable connects the editor, presence, and sync state" to="/docs/realtime/get-started" link-label="Connect a TipTap editor"}
`useRealtimeTiptap()` takes the Realtime Definition name and a Workspace path. It connects to the generated `/api/_vitehub/realtime/**` WebSocket route and exposes editor state as Vue refs.

Set `auth: true` on the Definition to require a valid ViteHub [Auth](/docs/auth) session and bind that user to presence. In a public Definition, presence identity is client-asserted.

#code
```ts [app/composables/useDocumentEditor.ts]
import { useEditor } from '@tiptap/vue-3'
import { useRealtimeTiptap } from 'vite-hub/realtime/vue'

export function useDocumentEditor() {
  const realtime = useRealtimeTiptap('docs', 'guides/getting-started.md')

  const editor = useEditor({
    extensions: realtime.extensions.value,
  })

  realtime.people.value // Connected people
  realtime.status.value // connected, connecting, or disconnected
  realtime.synced.value // Whether the initial Yjs sync has completed

  return { editor, realtime }
}
```
::

::product-feature{label="Room authority" title="Memory for one process, Durable Objects on Cloudflare" to="/docs/realtime/configure" link-label="Choose a room authority" reverse}
The `memory` authority keeps rooms in one process and loses them when the process stops. The `cloudflare` authority generates a SQLite-backed Durable Object binding and migration. `auto` selects Cloudflare when Realtime resolves a Cloudflare preset.

ViteHub rejects the memory authority on distributed host presets. A WebSocket message is limited to 1 MiB and the document state of a room to 8 MiB.

#code
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'node',
      realtime: { authority: 'memory' },
      workspace: true,
    }),
  ],
})
```
::

::product-feature{label="Checkpoints" title="A checkpoint writes canonical Markdown to Workspace" to="/docs/realtime/server-api" link-label="Create a durable checkpoint"}
A room update is collaborative state, not a Workspace write. Call a checkpoint when the current document must become canonical Markdown in Workspace.

Checkpoints require a Workspace Store with conditional writes. If Workspace changed during publication, Realtime rebases onto the remote head. A path changed both locally and remotely remains a Workspace conflict.

#code
```ts
const checkpoint = await realtime.history.checkpoint()

checkpoint.content
checkpoint.snapshot
```
::

::product-feature{label="Workspace" title="The document is a file in a writable Workspace" to="/docs/workspace" link-label="Read about Workspace" reverse}
The Realtime Definition names the Workspace that keeps the canonical document. `realtime.workspace.change` reports file changes from other Workspace clients. Call `realtime.workspace.notify(change)` after the application changes a path outside the editor.

Use Workspace alone when one writer changes files through server code or Agent tools. Use [Channels](/docs/channels) to send outbound messages, not to sync editor state.

#code
```ts [server/workspaces/docs.ts]
import { defineWorkspace } from 'vite-hub/workspace'

export default defineWorkspace({
  store: { provider: 'memory' },
  rules: {
    '/**': { write: true, mediaType: 'text/markdown' },
  },
})
```
::
