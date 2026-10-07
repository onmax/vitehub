---

title: Start your first Workflow
description: Install Workflows, register the Vite integration, and start the first run.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Workflows run named work outside the request and return a run id that the app
can inspect later. This tutorial starts one local run and reads its status from
an H3 route.

::note
You need Node.js 24.15 or newer, `pnpm`, and an existing Vite server app. Local
development runs inline. Choose Cloudflare, Vercel, or OpenWorkflow before
deploying work that must survive a process restart.
::

::tutorial-step{title="Install"}
## Install

```bash [Terminal]
pnpm add @vite-hub/runtime @vite-hub/workflow h3
pnpm add -D vite
```

::

::tutorial-step{title="Configure"}
## Configure

```ts [vite.config.ts]
import { hubWorkflow } from '@vite-hub/workflow/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubWorkflow()],
})
```

::

::tutorial-step{title="Define the Workflow"}
## Define the Workflow

```ts [server/workflows/onboard-user.ts]
import { defineWorkflow } from '@vite-hub/workflow'

export default defineWorkflow<{ email: string }>(async ({ payload }) => {
  return { accepted: true, email: payload.email }
})
```

```ts [server/api/onboard.post.ts]
import { defineEventHandler } from 'h3'
import { runWorkflow } from '@vite-hub/workflow'

export default defineEventHandler(async () => {
  return runWorkflow('onboard-user', { email: 'ada@example.com' })
})
```

::

::tutorial-step{title="Start and inspect a run"}
## Start and inspect a run

Start Vite and call the route:

```bash [Terminal]
pnpm vite dev
curl -X POST http://localhost:5173/api/onboard
```

The response includes a run id and a provider status. Use
[`getWorkflowRun()`](/docs/workflows/server-api#inspect-a-run) to inspect the
result after the handler completes.

::
