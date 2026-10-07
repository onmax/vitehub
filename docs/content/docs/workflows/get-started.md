---
title: Start your first Workflow
description: Install Workflows, register the Vite integration, and start the first run.
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/runtime @vite-hub/workflow
```

### Configure

```ts [vite.config.ts]
import { hubWorkflow } from '@vite-hub/workflow/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubWorkflow()],
})
```

### Start using it

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

::
