---
title: Build and inspect a welcome Queue
description: Discover a Queue Definition and inspect its Cloudflare output before deployment.
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Queue moves work out of the request. Your route gets a provider acceptance result, and a later delivery invokes the handler. A job can run more than once, so make side effects safe to retry.

::note
Queue has hosted providers only. This tutorial uses Cloudflare Queues and ends at build-time inspection. It does not enqueue or deliver a job. A deployed binding and a provisioned queue are required for runtime acceptance.
::

## Install and configure

Use Node.js 24 or newer. Start in an empty directory:

```bash [Terminal]
pnpm init
pnpm pkg set type=module
pnpm add @vite-hub/queue
pnpm add -D @vite-hub/cli vite
```

Register the integration in `vite.config.ts`:

```ts [vite.config.ts]
import { hubQueue } from '@vite-hub/queue/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  appType: 'custom',
  plugins: [hubQueue({ provider: 'cloudflare' })],
  build: { ssr: 'src/server.ts' },
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

## Add a server entry

Vite needs an explicit server entry. This entry keeps the enqueue helper available for a deployed host; it does not start a local HTTP server or invoke the queue during the build.

```ts [src/server.ts]
import { runQueue } from '@vite-hub/queue'

export async function enqueueWelcomeEmail(email: string) {
  return runQueue('welcome-email', { email })
}

export default function handleRequest() {
  return new Response('Queue producer ready')
}
```

## Inspect the definition

Build the app and inspect the generated definition before deploying:

```bash [Terminal]
pnpm vite build
pnpm vitehub inspect definitions --kind queue
```

You should see `welcome-email` with its file and source metadata. The build also writes `.vitehub/queue/registry.mjs` and Cloudflare Worker output with `wrangler.json` under `dist`. Inspect the producer binding and consumer entries there. These artifacts prove discovery and provider wiring, not delivery.

Before calling `enqueueWelcomeEmail()` from a deployed request handler, follow the [Cloudflare host guide](/docs/frameworks-hosts/cloudflare) to provision the queue and deploy the Worker with its binding. Only then can `runQueue()` return `{ status: "queued", messageId: "..." }`. That result means provider acceptance, not handler completion. Cloudflare does not support Vercel's `idempotencyKey` option.

## Continue

- Read [Make Queue handlers safe to retry](/docs/queue/configure#queue-definition-options) before sending non-repeatable side effects.
- Read the [Server API](/docs/queue/server-api) for delays, direct clients, and delivery failures.
- Read [Hosts](/docs/queue/hosts) before choosing Cloudflare or Vercel.
