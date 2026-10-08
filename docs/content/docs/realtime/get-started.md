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

Start with an existing Vite + Vue + TypeScript application and Node.js 24.15 or newer.
Run the commands from the application root. This tutorial uses Nitro to host
the generated Realtime routes alongside the Vue app.

```bash [commands/install]
pnpm add vite-hub @tiptap/vue-3 h3
pnpm add -D nitro
```

Enable Workspace and Realtime. The memory authority is suitable for local
development and a single-process Node server. Keep the Vue plugin from your
application; Nitro consumes the generated WebSocket route configuration.

```ts [vite.config.ts]
import vue from '@vitejs/plugin-vue'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    vue(),
    nitro() as never,
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

```ts [src/composables/useDocumentEditor.ts]
import { useEditor } from '@tiptap/vue-3'
import { useRealtimeTiptap } from 'vite-hub/realtime/vue'

export function useDocumentEditor() {
  const realtime = useRealtimeTiptap('docs', 'guides/getting-started.md')

  const editor = useEditor({
    extensions: realtime.extensions.value,
  })

  return { editor, realtime }
}
```

Render the editor in the Vite scaffold's root component. Destructure the status
refs so Vue unwraps them in the template. `useEditor()` disposes the editor when
the component unmounts.

```vue [src/App.vue]
<script setup lang="ts">
import { EditorContent } from '@tiptap/vue-3'
import { useDocumentEditor } from './composables/useDocumentEditor'

const { editor, realtime } = useDocumentEditor()
const { status, synced } = realtime
</script>

<template>
  <main>
    <h1>Collaborative document</h1>
    <p role="status">
      Realtime: {{ status }}, {{ synced ? 'Document synced' : 'Waiting for sync' }}
    </p>
    <EditorContent :editor="editor" />
  </main>
</template>
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

::tutorial-step{title="Verify synchronization"}
## Verify synchronization

Start the server and leave it running:

```bash [commands/dev]
pnpm vite dev
```

Open the local URL printed by Vite in two browser tabs. Both tabs should show
`Realtime: connected, Document synced`. Click the editor below the status in
one tab and type a sentence; it should appear in the other tab. Edit from the
second tab and verify that the first updates too. Both editors use the same
`docs` Definition and `guides/getting-started.md` document path.

Room updates synchronize the editors but do not write a Workspace file. An
explicit `realtime.history.checkpoint()` saves the current Markdown to the
Workspace. Both the room authority and Workspace store in this tutorial are
in memory, so restarting the server loses their state. Use a durable setup
before relying on documents surviving a restart.
::
