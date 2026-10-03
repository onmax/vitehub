---
title: Workflows
navigation.title: Overview
description: Start provider-tracked long-running work with run ids, durable state, and optional steps.
navigation.order: 1
icon: i-lucide-workflow
---

::product-hero{tagline="Start long-running work as a tracked run with an id, status, and result on Cloudflare, Vercel, or OpenWorkflow."}
  :::code-group
  ```ts [Route]
  import { runWorkflow } from '@vite-hub/workflow'

  export default defineEventHandler(async (event) => {
    const body = await readBody<{ email: string }>(event)

    return runWorkflow('onboard-user', body)
  })
  ```

  ```ts [Definition]
  import { defineWorkflow } from '@vite-hub/workflow'

  export default defineWorkflow<{ email: string }>(async ({ payload }) => {
    const user = await createUser(payload.email)
    await sendWelcomeEmail(user.email)

    return { userId: user.id }
  })
  ```

  ```ts [Status]
  import { getWorkflowRun } from '@vite-hub/workflow'

  export default defineEventHandler((event) => {
    return getWorkflowRun('onboard-user', getRouterParam(event, 'id')!)
  })
  ```

  ```ts [vite.config.ts]
  import { hubWorkflow } from '@vite-hub/workflow/vite'
  import { defineConfig } from 'vite'

  export default defineConfig({
    plugins: [hubWorkflow()],
    workflow: { provider: 'cloudflare' },
  })
  ```
  :::
::

::product-features
  :::product-feature-item{title="One file, one named Workflow" icon="i-lucide-code-2" to="/docs/workflows/configure" link-label="Configure Workflows"}
  The handler in `server/workflows/<name>.ts` receives the payload, the provider, the run id, and step helpers when the provider has them.
  :::

  :::product-feature-item{title="Start by name, read by id" icon="i-lucide-play-circle" to="/docs/workflows/server-api" link-label="Workflows server API"}
  `getWorkflowRun()` returns `queued`, `running`, `completed`, `failed`, `cancelled`, or `unknown`, with the result when it is available.
  :::

  :::product-feature-item{title="Durable steps on Vercel with a native entry" icon="i-lucide-workflow" to="/docs/workflows/configure#add-a-durable-vercel-entry" link-label="Add a durable Vercel entry"}
  On Vercel, a `native` entry runs on Workflow DevKit for durable steps, and other providers keep the normal handler.
  :::

  :::product-feature-item{title="One error contract on every provider" icon="i-lucide-circle-alert" to="/docs/workflows/limits-and-errors" link-label="Workflows limits and errors"}
  Throw `ViteHubError` with a stable `code`, and `toJSON()` returns the code, the message, and JSON-safe `details` without `cause`.
  :::

  :::product-feature-item{title="Pick the provider and its storage per host" icon="i-lucide-cloud-cog" to="/docs/workflows/hosts" link-label="Workflows hosts"}
  ViteHub selects Cloudflare on Cloudflare and Vercel on other supported hosts; on Node or Docker, `postgres.url` or `sqlite.path` stores runs with OpenWorkflow.
  :::

  :::product-feature-item{title="Not for plain job delivery or cron times" icon="i-lucide-git-branch" to="/docs/queue" link-label="Compare Queue"}
  Use Queue when delivering a job is enough, and Schedule to start work on cron times.
  :::
::
