---
title: Process a welcome job with Queue
description: Enqueue a job from a route, then let a provider deliver it after the request ends.
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Queue moves work out of the request. Your route gets a provider acceptance result, and a later delivery invokes the handler. A job can run more than once, so make side effects safe to retry.

::note
Queue has hosted providers only. This tutorial uses Cloudflare Queues. Use Vercel Queues by changing the provider and installing `@vercel/queue`.
::

## Install and configure

```bash [Terminal]
pnpm add @vite-hub/queue h3
pnpm add -D @vite-hub/cli vite
```

Register the integration in `vite.config.ts`:

```ts [vite.config.ts]
import { hubQueue } from '@vite-hub/queue/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubQueue({ provider: 'cloudflare' })],
})
```

With the `vite-hub` distribution, use `vitehub({ preset: 'cloudflare', queue: true })` and import from `vite-hub/queue`.

## Define the job

Create `server/queues/welcome-email.ts`:

```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vite-hub/queue'

export default defineQueue<{ email: string }>(async ({ payload, id }) => {
  console.log(`Processing welcome job ${id} for ${payload.email}`)
})
```

The file name becomes the Queue Definition name. The handler runs in the provider consumer, after the route has returned.

## Enqueue from a route

```ts [server/api/welcome.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { runQueue } from '@vite-hub/queue'

export default defineEventHandler(async (event) => {
  const { email } = await readBody<{ email: string }>(event)

  return runQueue('welcome-email', { email })
})
```

The response is an acceptance signal:

```json [Response]
{ "status": "queued", "messageId": "..." }
```

`status: 'queued'` does not contain the handler result. The provider will deliver the job later and may retry it after a failure. Make the handler safe to run more than once. Cloudflare does not support Vercel's `idempotencyKey`; use that option only when you select the Vercel provider.

## Inspect the definition

Build the app and inspect the generated definition before deploying:

```bash [Terminal]
pnpm vite build
pnpm vitehub inspect definitions --kind queue
```

You should see `welcome-email` with its source file and payload registry. Send a request, then look for the handler log in the provider consumer.

## Continue

- Read [Make Queue handlers safe to retry](/docs/queue/configure#queue-definition-options) before sending non-repeatable side effects.
- Read the [Server API](/docs/queue/server-api) for delays, direct clients, and delivery failures.
- Read [Hosts](/docs/queue/hosts) before choosing Cloudflare or Vercel.
