---
title: Queue get started
description: Install Queue, register the Vite Integration, and enqueue a first Queue Job.
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/queue @vite-hub/runtime
```

For Vercel Queues, also install the provider package and ambient TypeScript types:

```bash [Terminal]
pnpm add @vercel/queue
pnpm add -D @types/node @types/ws
```

### Configure

```ts [vite.config.ts]
import { hubQueue } from '@vite-hub/queue/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubQueue({ provider: 'cloudflare' })],
})
```

### Start using it

```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vite-hub/queue'

export default defineQueue<{ email: string }>(async ({ payload }) => {
  await sendWelcomeEmail(payload.email)
})
```

```ts [server/api/welcome.post.ts]
import { runQueue } from '@vite-hub/queue'

export default defineEventHandler(async () => {
  return runQueue('welcome-email', { email: 'ada@example.com' })
})
```

::

With the `vite-hub` package, use `vitehub({ preset, queue: true })` and import from `vite-hub/queue`. The `cloudflare` and `vercel` presets select the matching provider. On Cloudflare, `vitehub()` also sets `namePrefix` to `<app-name>-`. Other presets reject Queue.
