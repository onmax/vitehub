---

title: Start your first Workflow
description: Install Workflows, split a run into durable steps, and inspect the first result.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Workflows run named work outside the request and return a run id that the app
can inspect later. This tutorial builds a small onboarding run with two ordered
steps. The code rail mirrors the project tree, so you can see the workflow
entrypoint, its step files, and the route that starts it together.

::note
You need Node.js 24.15 or newer, `pnpm`, and an existing Vite server app. Local
development runs inline. Choose Cloudflare, Vercel, or OpenWorkflow before
deploying work that must survive a process restart.
::

::tutorial-step{title="Install"}
## Install

```bash [commands/install.sh]
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

::tutorial-step{title="Define the Workflow steps"}
## Define the Workflow steps

Use a folder when a Workflow has more than one durable operation. The
`index.ts` file receives the payload and calls the generated step functions in
order. Files with a numeric prefix become step names (`01.create-user` and
`02.send-welcome`) and each step can be retried or replayed independently.

```ts [server/workflows/onboard-user/index.ts]
import { defineWorkflow } from '@vite-hub/workflow'

export default defineWorkflow<{ email: string }>(async ({ payload, steps }) => {
  const user = await steps!.createUser(payload)
  return await steps!.sendWelcome(user)
})
```

The step runner is provider-neutral. ViteHub maps `createUser` to
`01.create-user.ts` and `sendWelcome` to `02.send-welcome.ts`.

```ts [server/workflows/onboard-user/01.create-user.ts]
export default async function createUser(input: { email: string }) {
  // Replace this with an idempotent database write.
  return { id: `user:${input.email}`, email: input.email }
}
```

```ts [server/workflows/onboard-user/02.send-welcome.ts]
export default async function sendWelcome(user: { id: string, email: string }) {
  // Replace this with an idempotent email or notification call.
  return { userId: user.id, email: user.email, welcomeSent: true }
}
```

Keep side effects idempotent. A provider can replay a step after a transient
failure, but it does not need to repeat earlier completed steps.

::

::tutorial-step{title="Start the Workflow from a route"}
## Start the Workflow from a route

The route only starts the run. It receives an acknowledgement with a run id;
the two step functions execute in the Workflow provider.

```ts [server/api/onboard.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { runWorkflow } from '@vite-hub/workflow'

export default defineEventHandler(async (event) => {
  const payload = await readBody<{ email: string }>(event)
  return runWorkflow('onboard-user', payload)
})
```

::

::tutorial-step{title="Start and inspect a run"}
## Start and inspect a run

Start Vite and call the route:

```bash [commands/run.sh]
pnpm vite dev
curl -X POST http://localhost:5173/api/onboard
```

The response includes a run id and a provider status. Use
[`getWorkflowRun()`](/docs/workflows/server-api#inspect-a-run) with that id to
inspect the two step results after the handler completes. The returned run
contains one entry for `01.create-user` and one for `02.send-welcome`.

::
