---
title: Workflows
navigation.title: Overview
description: Start provider-tracked long-running work with run ids, durable state, and optional steps.
navigation.order: 1
icon: i-lucide-workflow
---

Use Workflows for long-running work that needs a tracked run, retries, resumable state, or durable steps. These guarantees depend on the provider and Definition: Vercel's normal handler runs inline; [a native entry](/docs/workflows/configure#add-a-durable-vercel-entry) enables durable execution.

Use [Queue](/docs/queue) when you only need to deliver a job. A Workflow starts and tracks a run.

This Workflow Definition creates a user, and a server route starts one run of it:

```ts [server/workflows/onboard-user.ts]
import { defineWorkflow } from '@vite-hub/workflow'

export default defineWorkflow<{ email: string }>(async ({ payload }) => {
  return createUser(payload.email)
})
```

```ts [server/api/onboard.post.ts]
import { runWorkflow } from '@vite-hub/workflow'

export default defineEventHandler(async () => {
  return runWorkflow('onboard-user', { email: 'ada@example.com' })
})
```

## Connect Workflows to Agents

An Agent can start a workflow only when you expose that action through a Capability or server route. Workflows track durable work. Agents provide model-backed behavior.

Use a product-specific Capability when a model needs to start or inspect a particular Workflow Run.
