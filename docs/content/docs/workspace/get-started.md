---

title: Build your first Workspace
description: Install Workspace, register the Vite integration, define a Workspace, and read and write files from server code.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Install the Workspace package, register the Vite integration, and make the first call from server code.

Workspace is a persistent file tree with explicit path rules. This tutorial
defines a local read-only Source, lists its files from a route, and then writes
one draft with a separate write request.

::note
You need Node.js 24.15 or newer, `pnpm`, and an existing Vite server app. The
default local store is for development. Read [Hosts](/docs/workspace/hosts) for
Cloudflare Artifacts, Vercel Blob, and GitHub stores.
::

::tutorial-step{title="Install"}
## Install

```bash [commands/install]
pnpm add @vite-hub/workspace h3
pnpm add -D vite
```

::

::tutorial-step{title="Configure"}
## Configure

```ts [vite.config.ts]
import { hubWorkspace } from '@vite-hub/workspace/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubWorkspace()],
})
```

::

::tutorial-step{title="Define the Workspace"}
## Define the Workspace

```ts [server/workspaces/docs.ts]
import { defineWorkspace, glob } from '@vite-hub/workspace'

export default defineWorkspace({
  sources: {
    docs: glob({ include: ['docs/**/*.md'] }),
  },
})
```

::


::tutorial-step{title="Use it at runtime"}
## Use it at runtime

Read files from server code with `useWorkspace()`.

```ts [server/api/docs.get.ts]
import { defineEventHandler } from 'h3'
import { useWorkspace } from '@vite-hub/workspace'

export default defineEventHandler(async () => {
  const workspace = useWorkspace('docs')
  return workspace.fs.glob('**/*.md')
})
```

Request write access only at the call site that needs mutation.

```ts [server/api/drafts.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { useWorkspace } from '@vite-hub/workspace'

export default defineEventHandler(async (event) => {
  const workspace = useWorkspace('docs', { mode: 'write' })
  const body = await readBody<{ text: string }>(event)

  await workspace.fs.writeFile('drafts/summary.md', body.text, {
    mediaType: 'text/markdown',
  })

  return workspace.diff()
})
```

::

::tutorial-step{title="Read and write the tree"}
## Read and write the tree

Start Vite and call the read route:

```bash [commands/request]
pnpm vite dev
curl http://localhost:5173/api/docs
```

The response lists Markdown files from the `docs` mount. Send a draft to the
write route when you need mutation:

```bash [commands/write]
curl -X POST http://localhost:5173/api/drafts \
  -H 'content-type: application/json' \
  -d '{"text":"# Draft"}'
```

The write response is a Workspace diff. Read [Server API](/docs/workspace/server-api)
for snapshots, commits, and Source sync.

::
