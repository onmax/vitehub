---
title: Queue
navigation.title: Overview
description: Define Queue Definitions, enqueue Queue Jobs, and choose Cloudflare or Vercel Queue Providers.
navigation.order: 1
icon: i-lucide-list-ordered
---

Use Queue when a request needs to hand off work and return before that work finishes. You define a handler in a Queue Definition, then call `runQueue()` with the Definition name and a payload. ViteHub sends the job to Cloudflare Queues or Vercel Queues, and the provider delivers it to your handler later.

Enqueueing confirms that the provider accepted the job. It does not confirm that the handler ran successfully. Queue works without Agents.

::tip
Choose the background-work primitive by what the caller needs:

- Queue: hand off one job and return. The caller gets provider acceptance, not a handler result or run status.
- [Workflows](/docs/workflows): long-running work with a tracked run id, durable steps, waits, and progress inspection.
- [Schedule](/docs/schedule): start work at cron times, from static entries or Runtime Schedules.
::

This Queue Definition sends a welcome email, and a server route enqueues one job for it:

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

## Connect Queue to Agents

Queue has no official Agent Capability. An Agent can enqueue work only when you expose that behavior through an app-owned Capability or server route.

Keep the Capability specific to the product task. Do not give a model arbitrary queue access because the app uses Queue internally.
