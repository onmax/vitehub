---
title: Store your first Blob object
description: Install Blob, write one object, and verify its stored metadata.
navigation.title: Tutorial
layout: tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Blob stores uploads and generated files as binary objects. This tutorial uses
the local `fs` driver, writes one text object, and returns the stored metadata.

::note
You need Node.js 24.15 or newer, `pnpm`, and an existing Vite server app. The
local store writes to `.vitehub/data/blob`; use R2, Vercel Blob, or another
provider for production.
::

::tutorial-step{title="Install and configure"}
## Install and configure

```bash [commands/install]
pnpm add @vite-hub/blob nitro h3
pnpm add -D @vite-hub/cli vite
```

Register Blob and select the local store:

```ts [vite.config.ts]
import { hubBlob } from '@vite-hub/blob/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  blob: {
    driver: 'fs',
    base: '.vitehub/data/blob',
  },
  plugins: [hubBlob(), nitro() as never],
})
```

::

::tutorial-step{title="Write one object"}
## Write one object

Create a route that stores one object and returns the result:

```ts [server/api/files.post.ts]
import { defineEventHandler } from 'h3'
import { blob } from '@vite-hub/blob'

export default defineEventHandler(async () => {
  const [error, object] = await blob.put('hello.txt', 'Hello from ViteHub', {
    contentType: 'text/plain',
  })
  if (error) throw error
  return object
})
```

`blob.put()` returns `[error, object]`. The object includes its pathname,
content type, size, and upload timestamp.

::

::tutorial-step{title="Verify the result"}
## Verify the result

Start Vite and send one request:

```bash [commands/request]
pnpm vite dev
curl -X POST http://localhost:5173/api/files
```

The response contains metadata for `hello.txt`:

```json [output/response.json]
{
  "pathname": "hello.txt",
  "contentType": "text/plain",
  "size": 18,
  "httpEtag": "..."
}
```

Use `pnpm vitehub blob head hello.txt --json` to inspect the same object from
the development server. Continue with [Server API](/docs/blob/server-api) for
uploads and reads, then [Hosts](/docs/blob/hosts) before choosing a hosted
store.
::
