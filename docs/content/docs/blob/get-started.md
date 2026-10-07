---
title: Store your first Blob object
description: Install Blob, register the Vite integration, and write the first object.
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/blob
```

### Configure

```ts [vite.config.ts]
import { hubBlob } from '@vite-hub/blob/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubBlob()],
})
```

### Start using it

```ts [server/api/files.post.ts]
import { blob } from '@vite-hub/blob'

export default defineEventHandler(async () => {
  const [error, object] = await blob.put('hello.txt', 'Hello from ViteHub')
  if (error) throw error
  return object
})
```

::

Read [Server API](/docs/blob/server-api) for every Blob method.
