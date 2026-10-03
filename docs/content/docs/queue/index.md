---
title: Queue
navigation.title: Overview
description: Define Queue Definitions, enqueue Queue Jobs, and choose Cloudflare or Vercel Queue Providers.
navigation.order: 1
icon: i-lucide-list-ordered
---

::product-hero{providers="Cloudflare, Vercel" tagline="One runQueue() call sends a job to Cloudflare Queues or Vercel Queues, and the request returns before it runs."}
  :::code-group
  ```ts [Route]
  import { deferQueue, runQueue } from '@vite-hub/queue'

  export default defineEventHandler(async (event) => {
    const body = await readBody<{ email: string }>(event)

    // Resolves with { messageId, status: 'queued' } once the provider accepts the job.
    const queued = await runQueue('welcome-email', { email: body.email }, {
      delaySeconds: 60,
    })

    // Enqueues through waitUntil, so the response does not wait for the provider.
    deferQueue('report', { reportId: `signup:${body.email}` })

    return queued
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

::product-flow{caption="runQueue() returns when the provider accepts the job, before the handler runs."}
  :::product-flow-step{label="Route" detail="runQueue('welcome-email', payload)"}
  :::
  :::product-flow-step{label="Provider" detail="cloudflare · vercel"}
  :::
  :::product-flow-step{label="Accepted" detail="{ status: 'queued', messageId }"}
  :::
  :::product-flow-step{label="Handler" detail="server/queues/<name>.ts" loop}
  :::
::

::product-features
  :::product-feature-item{title="The file name is the queue name" icon="i-lucide-code-2" to="/docs/queue/configure"}
  `server/queues/<name>.ts` defines the queue; ViteHub generates provider names.
  :::

  :::product-feature-item{title="Enqueue confirms acceptance, not the handler result" icon="i-lucide-list-ordered" to="/docs/queue/server-api"}
  `runQueue()` resolves with `status: 'queued'` when the provider accepts.
  :::

  :::product-feature-item{title="Typed names, payloads, and options" icon="i-lucide-shield-check" to="/docs/queue/server-api#queue-enqueue-options"}
  Typed from Definitions; an unsupported option throws `ViteHubError`.
  :::

  :::product-feature-item{title="A handler must tolerate a second delivery" icon="i-lucide-circle-alert" to="/docs/queue/limits-and-errors"}
  Providers retry failed delivery; ViteHub does not guarantee exactly once.
  :::

  :::product-feature-item{title="Check discovery and provider output with a build" icon="i-lucide-terminal" to="/docs/queue/hosts"}
  No local delivery; build and inspect the Wrangler or Vercel output.
  :::

  :::product-feature-item{title="Not for tracked runs or cron times" icon="i-lucide-git-branch" to="/docs/workflows"}
  Use Workflows for run status, Schedule for cron times.
  :::
::
