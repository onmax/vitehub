---
title: Queue
navigation.title: Overview
description: Define Queue Definitions, enqueue Queue Jobs, and choose Cloudflare or Vercel Queue Providers.
navigation.order: 1
icon: i-lucide-list-ordered
---

::product-hero{tagline="Hand off a job from a request and return before the job runs. One runQueue() call sends it to Cloudflare Queues or Vercel Queues."}

```ts [server/api/welcome.post.ts]
import { runQueue } from '@vite-hub/queue'

export default defineEventHandler(async () => {
  return runQueue('welcome-email', { email: 'ada@example.com' })
})
```

::

::product-feature{label="Definitions" title="The file name is the queue name" to="/docs/queue/configure" link-label="Define a queue and pick a provider"}
Put a handler in `server/queues/<name>.ts`. ViteHub discovers it, and `runQueue()` addresses it by that name. Definition options set Cloudflare batch concurrency or Vercel callback options.

Select the Queue Provider once. ViteHub generates the queue names, bindings, and topics, so application code never depends on them.

#code
```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vite-hub/queue'

export default defineQueue<{ email: string }>(async ({ payload }) => {
  await sendWelcomeEmail(payload.email)
})
```

```ts [vite.config.ts]
import { hubQueue } from '@vite-hub/queue/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubQueue({ provider: 'cloudflare' })],
})
```
::

::product-feature{label="Server API" title="Enqueue confirms acceptance, not the handler result" to="/docs/queue/server-api" link-label="Read the Queue server API" reverse}
`runQueue()` resolves with `status: 'queued'` when the provider accepts the job. `deferQueue()` enqueues through the request's `waitUntil` and returns at once.

Names and payloads are typed from the discovered Definitions. An enqueue option that the provider does not support throws a `ViteHubError` instead of being ignored.

#code
```ts [server/api/signup.post.ts]
import { runQueue } from '@vite-hub/queue'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email: string }>(event)

  return runQueue('welcome-email', { email: body.email })
})
```
::

::product-feature{label="Delivery" title="A handler must tolerate a second delivery" to="/docs/queue/limits-and-errors" link-label="Check delivery limits and errors"}
Providers retry failed delivery, and ViteHub does not guarantee exactly-once delivery. Make each handler safe to run again after a partial side effect.

Throw `ViteHubError` for a stable failure code. Decide to acknowledge or retry in `onError` on Cloudflare and `callbackOptions.retry` on Vercel.

#code
```ts [server/queues/image-expiry.ts]
import { getViteHubErrorShape, ViteHubError } from '@vite-hub/runtime'
import { defineQueue } from '@vite-hub/queue'

export default defineQueue<{ key?: string }>(async ({ payload }) => {
  if (!payload.key) {
    throw new ViteHubError('EXPIRY_INVALID_PAYLOAD', 'Image expiry payload requires a key.', {
      details: { field: 'key' },
    })
  }

  await deleteImage(payload.key)
}, {
  onError: error => getViteHubErrorShape(error)?.code === 'EXPIRY_INVALID_PAYLOAD' ? 'ack' : undefined,
  callbackOptions: {
    retry: error => getViteHubErrorShape(error)?.code === 'EXPIRY_INVALID_PAYLOAD'
      ? { acknowledge: true }
      : undefined,
  },
})
```
::

::product-feature{label="Hosts" title="Check discovery and provider output with a build" to="/docs/queue/hosts" link-label="See host and provider notes" reverse}
Queue has no local delivery provider. Build the app, list the discovered Definitions, then inspect the Wrangler queue entries or the Vercel consumer functions.

Use [Workflows](/docs/workflows) when the caller needs a run id and status, and [Schedule](/docs/schedule) for work on cron times.

#code
```bash [Terminal]
pnpm add vite-hub
pnpm vite build
pnpm vitehub inspect definitions --kind queue
```
::
