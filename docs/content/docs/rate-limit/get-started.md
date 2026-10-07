---
title: Guard your first request
description: Register the Rate Limit integration and guard a first server handler.
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

## Quick start

Register the integration. The `node` preset uses process-local memory, also during local Vite development. The `cloudflare` preset uses Cloudflare Rate Limiting. The `vercel`, `netlify`, and `deno` presets reject `rateLimit`.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ preset: "node", rateLimit: true })],
})
```

Require the Rate Limit directly in ordinary server code. The guard does not need a dedicated directory, file suffix, or module-scope declaration.

```ts [server/api/image-upload.post.ts]
import { requireRateLimit } from 'vite-hub/rate-limit'

export default defineEventHandler(async (event) => {
  await requireRateLimit(event, 'image-upload', {
    limit: 10,
    window: '1m',
  })
  return { ok: true }
})
```

`requireRateLimit()` uses the event's client address and throws a standard H3 `HTTPError` when the request is limited. Pass `key: authenticatedUser.id` when a user, account, tenant, or API client is the correct budget boundary.
