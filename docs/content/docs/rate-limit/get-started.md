---

title: Guard your first request
description: Install Rate Limit, reject a repeated request, and inspect the local decision.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Rate Limit stops a request before the handler performs work. This tutorial uses
the Node memory driver, so you can see the first two requests pass and the third
request return `429` without a provider account.

::note
You need Node.js 24.15 or newer, `pnpm`, and an existing Vite server app. The
memory driver is for development and one process; choose a hosted preset before
you deploy multiple instances.
::

::tutorial-step{title="Install and configure"}
## Install and configure

```bash [commands/install]
pnpm add vite-hub
```

Register the integration. The `node` preset uses process-local memory, also during local Vite development. The `cloudflare` preset uses Cloudflare Rate Limiting. The `vercel`, `netlify`, and `deno` presets reject `rateLimit`.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', rateLimit: true })],
})
```

::

::tutorial-step{title="Protect one route"}
## Protect one route

Require the Rate Limit directly in ordinary server code. The guard does not need a dedicated directory, file suffix, or module-scope declaration.

```ts [server/api/image-upload.post.ts]
import { defineEventHandler } from 'h3'
import { requireRateLimit } from 'vite-hub/rate-limit'

export default defineEventHandler(async (event) => {
  await requireRateLimit(event, 'image-upload', {
    limit: 2,
    window: '1m',
  })
  return { ok: true, message: 'accepted' }
})
```

::

::tutorial-step{title="Run and verify the decision"}
## Run and verify the decision

Start the dev server and call the route three times from the same client:

```bash [commands/request]
pnpm vite dev
curl -i -X POST http://localhost:5173/api/image-upload
curl -i -X POST http://localhost:5173/api/image-upload
curl -i -X POST http://localhost:5173/api/image-upload
```

The first two responses are `200` with `{ "ok": true, "message": "accepted" }`.
The third response is `429`. `requireRateLimit()` uses the event's client
address by default and throws a standard H3 `HTTPError` when the request is
limited. Pass `key: authenticatedUser.id` when a user, account, tenant, or API
client is the correct budget boundary.

Inspect the generated policy before choosing a hosted provider:

```bash [commands/inspect]
pnpm vite build
pnpm vitehub inspect definitions --kind rate-limit
```

Continue with [Hosts](/docs/rate-limit/hosts) for Cloudflare output and
[limits and errors](/docs/rate-limit/limits-and-errors) for production checks.
::
