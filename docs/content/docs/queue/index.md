---
title: Queue
navigation.title: Overview
description: Define Queue Definitions, enqueue Queue Jobs, and choose Cloudflare or Vercel Queue Providers.
navigation.order: 1
icon: i-lucide-list-ordered
---

::product-hero{tagline="One runQueue() call sends a job to Cloudflare Queues or Vercel Queues, and the request returns before it runs."}
  :::code-group
  ```ts [Route]
  import { runQueue } from '@vite-hub/queue'

  export default defineEventHandler(async (event) => {
    const body = await readBody<{ email: string }>(event)

    return runQueue('welcome-email', { email: body.email })
  })
  ```

  ```ts [Definition]
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

  ```bash [CLI]
  pnpm vite build
  pnpm add vite-hub
  pnpm vitehub inspect definitions --kind queue
  ```
  :::
::

::product-features
  :::product-feature-item{title="The file name is the queue name" icon="i-lucide-code-2" to="/docs/queue/configure" link-label="Configure Queue"}
  ViteHub discovers `server/queues/<name>.ts` and generates the provider queue names, bindings, and topics, so app code never depends on them.
  :::

  :::product-feature-item{title="Enqueue confirms acceptance, not the handler result" icon="i-lucide-list-ordered" to="/docs/queue/server-api" link-label="Queue server API"}
  `runQueue()` resolves with `status: 'queued'` once the provider accepts the job, and `deferQueue()` enqueues through `waitUntil`.
  :::

  :::product-feature-item{title="Typed names, payloads, and options" icon="i-lucide-shield-check" to="/docs/queue/server-api#queue-enqueue-options" link-label="Queue Enqueue options"}
  Names and payloads are typed from the discovered Definitions, and an option the provider does not support throws a `ViteHubError`.
  :::

  :::product-feature-item{title="A handler must tolerate a second delivery" icon="i-lucide-circle-alert" to="/docs/queue/limits-and-errors" link-label="Queue limits and errors"}
  Providers retry failed delivery and ViteHub does not guarantee exactly once, so make each handler safe to run again.
  :::

  :::product-feature-item{title="Check discovery and provider output with a build" icon="i-lucide-terminal" to="/docs/queue/hosts" link-label="Queue hosts"}
  Queue has no local delivery provider, so build, list the discovered Definitions, and inspect the Wrangler entries or Vercel consumer functions.
  :::

  :::product-feature-item{title="Not for tracked runs or cron times" icon="i-lucide-git-branch" to="/docs/workflows" link-label="Compare Workflows"}
  Use Workflows when the caller needs a run id and status, and Schedule for work on cron times.
  :::
::
