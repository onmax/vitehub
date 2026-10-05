---
title: Sandbox get started
description: Install Sandbox, select a provider, and run a first package project.
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

## Quick start

::steps{level="3"}

### Install

Install Sandbox and the provider package for your deployment. This example uses Vercel Sandbox:

```bash [Terminal]
pnpm add @vite-hub/sandbox @vercel/sandbox
```

For Cloudflare, install `@cloudflare/sandbox` instead. Sandbox requires Node.js 24 or newer.

### Configure

```ts [vite.config.ts]
import { hubSandbox } from '@vite-hub/sandbox/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubSandbox({ provider: 'vercel' })],
})
```

With the `vite-hub` distribution, set `sandbox: true`. The `cloudflare` and `vercel` presets select the matching provider:

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'

export default {
  plugins: vitehub({ preset: 'vercel', sandbox: true }),
}
```

### Start using it

Every discovered Definition belongs to a real package project. ViteHub never writes a manifest into your repository, so create the smallest valid one:

```json [server/sandboxes/release-notes/package.json]
{
  "private": true,
  "type": "module",
  "vitehub": {
    "sandbox": {
      "timeout": 30000
    }
  }
}
```

```ts [server/sandboxes/release-notes/index.ts]
interface SandboxPayload {
  notes?: string
}

export default async function releaseNotes(payload: SandboxPayload = {}) {
  return { text: payload.notes?.toUpperCase() || 'No notes' }
}
```

```ts [server/api/release-notes.post.ts]
import { runSandbox } from '@vite-hub/sandbox'

export default defineEventHandler(async () => {
  return runSandbox('release-notes', { notes: 'ship it' })
})
```

::
