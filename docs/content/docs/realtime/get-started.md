---

title: Create your first collaborative room
description: Install Realtime, enable it with Workspace, define a room, and connect a TipTap editor.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

::tutorial-step{title="Configure Realtime"}
## Configure Realtime

Install the ViteHub distribution in a Vue or Nuxt application.

```bash [Terminal]
pnpm add vite-hub @tiptap/vue-3
```

Enable Workspace and Realtime. The memory authority is suitable for local
development and a single-process Node server.

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

Create a Realtime Definition under `server/realtime`. Its name comes from the
relative file path, so this file defines `docs`.

```ts [server/realtime/docs.ts]
import { defineRealtime } from 'vite-hub/realtime'

export default defineRealtime({
  document: { workspace: 'docs' },
  history: {
    checkpoint: { message: 'Save collaborative document' },
  },
})
```

Add the writable Workspace referenced by the Realtime Definition. This memory
store matches the local, single-process setup above.

```ts [server/workspaces/docs.ts]
import { defineWorkspace } from 'vite-hub/workspace'

export default defineWorkspace({
  store: { provider: 'memory' },
  rules: {
    '/**': { write: true, mediaType: 'text/markdown' },
  },
})
```

Set `auth: true` on the Realtime Definition when every WebSocket and checkpoint
request must have a valid ViteHub Auth session. Connections are public when
`auth` is omitted.

::

::tutorial-step{title="Connect a TipTap editor"}
## Connect a TipTap editor

Call `useRealtimeTiptap()` with the Realtime Definition name and a safe
Workspace path. Its editor state is exposed as Vue refs.

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

The composable connects to ViteHub's generated
`/api/_vitehub/realtime/**` WebSocket route. With `auth: true`, the server
verifies the ViteHub Auth session and binds that user to presence updates. In a
public Definition, presence identity is client-asserted, even if the client has a
session. It must not be used as an authorization or verified-identity boundary.

`realtime.workspace.change` reports file changes published by other Workspace
clients. Call `realtime.workspace.notify(change)` after an application changes
a Workspace path outside the collaborative editor.
::
