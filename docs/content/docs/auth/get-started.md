---
title: Auth get started
description: Install Auth, register the Vite integration, and create the first session.
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/auth @vite-hub/runtime better-auth
```

### Configure

```ts [vite.config.ts]
import { hubAuth } from '@vite-hub/auth/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubAuth()],
})
```

### Start using it

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  emailAndPassword: { enabled: true },
})
```

Start the Vite dev server. ViteHub mounts Better Auth at `/api/auth/**`, so `POST /api/auth/sign-up/email` creates a user and a session.

::

With the `vite-hub` package, enable Auth with `vitehub({ preset, auth: true })` and import from `vite-hub/auth` and its `server`, `agent`, and `vue` subpaths.

This default proves discovery and the session route. It is not durable storage. Supply a Better Auth database adapter before you rely on sessions across restarts or replicas. See [Storage placement metadata](/docs/auth/configure#storage-placement-metadata).
