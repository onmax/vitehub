---
title: Workflows
navigation.title: Overview
description: Start provider-tracked long-running work with run ids, durable state, and optional steps.
navigation.order: 1
icon: i-lucide-workflow
---

::product-hero{tagline="Start long-running work as a tracked run with an id, a status, and a result. The same Definition runs on Cloudflare Workflows, Vercel, and OpenWorkflow."}

```ts [server/api/onboard.post.ts]
import { runWorkflow } from '@vite-hub/workflow'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email: string }>(event)

  return runWorkflow('onboard-user', body)
})
```

::

::product-feature{label="Definitions" title="One file, one named Workflow" to="/docs/workflows/configure" link-label="Define a Workflow"}
Put a handler in `server/workflows/<name>.ts`. The file name is the Definition name. The handler receives the payload, the provider, the run id, and step helpers when the provider has them.

Use Workflow Steps only when the work needs units that retry or show progress on their own.

#code
```ts [server/workflows/onboard-user.ts]
import { defineWorkflow } from '@vite-hub/workflow'

export default defineWorkflow<{ email: string }>(async ({ payload }) => {
  const user = await createUser(payload.email)
  await sendWelcomeEmail(user.email)

  return { userId: user.id }
})
```
::

::product-feature{label="Server API" title="Start a run by name, read it by id" to="/docs/workflows/server-api" link-label="Read the Workflows server API" reverse}
`runWorkflow()` starts a run. `getWorkflowRun()` returns its status: `queued`, `running`, `completed`, `failed`, `cancelled`, or `unknown`, with the result when it is available.

`cancelWorkflow()` and `resumeWorkflowSignal()` need a native Vercel Definition. Other providers report the operation as unsupported.

#code
```ts [server/api/workflows/[id].get.ts]
import { getWorkflowRun } from '@vite-hub/workflow'

export default defineEventHandler((event) => {
  return getWorkflowRun('onboard-user', getRouterParam(event, 'id')!)
})
```
::

::product-feature{label="Durability" title="Durable steps on Vercel with a native entry" to="/docs/workflows/configure#add-a-durable-vercel-entry" link-label="Add a durable Vercel entry"}
Vercel runs the normal handler inline, and inline work does not survive a function restart. A `native` entry uses Workflow DevKit for durable execution. Other providers keep the normal handler.

A step can retry, so keep side effects in `use step` functions and make them idempotent.

#code
```ts [server/workflows/onboard-user.ts]
import {
  defineWorkflow,
  type WorkflowExecutionContext,
} from '@vite-hub/workflow'

interface OnboardPayload {
  email: string
}

async function createUserStep(email: string) {
  'use step'

  return await createUser(email)
}

async function durableOnboard({ payload }: WorkflowExecutionContext<OnboardPayload>) {
  'use workflow'

  const user = await createUserStep(payload.email)
  return { userId: user.id }
}

async function inlineOnboard({ payload }: WorkflowExecutionContext<OnboardPayload>) {
  const user = await createUser(payload.email)
  return { userId: user.id }
}

export default defineWorkflow(inlineOnboard, { native: durableOnboard })
```
::

::product-feature{label="Errors" title="One error contract on every provider" to="/docs/workflows/limits-and-errors" link-label="Check limits and errors" reverse}
Throw `ViteHubError` with a stable `code` and a public `message`. `toJSON()` returns the code, the message, and JSON-safe `details`. It omits `cause`, which stays on the in-memory error for logs.

Retries stay on the Workflow Step. Throwing an error does not change the retry policy.

#code
```ts [server/workflows/transcribe.ts]
import { ViteHubError } from '@vite-hub/runtime'
import { defineWorkflow } from '@vite-hub/workflow'

export default defineWorkflow<{ recordingId: string }>(async ({ payload }) => {
  try {
    return await transcribeRecording(payload.recordingId)
  }
  catch (cause) {
    throw new ViteHubError('TRANSCRIPTION_FAILED', 'Transcription failed.', {
      cause,
      details: { recordingId: payload.recordingId },
    })
  }
})
```
::

::product-feature{label="Hosts" title="Pick the provider and its storage per host" to="/docs/workflows/hosts" link-label="See host and provider notes"}
ViteHub selects Cloudflare on Cloudflare hosting and Vercel on other supported hosts. On Node or Docker, set `postgres.url` or `sqlite.path` to store runs with OpenWorkflow.

Use [Queue](/docs/queue) when delivering a job is enough, and [Schedule](/docs/schedule) to start work on cron times.

#code
```ts [vite.config.ts]
import { hubWorkflow } from '@vite-hub/workflow/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubWorkflow()],
  workflow: { provider: 'cloudflare' },
})
```
::
