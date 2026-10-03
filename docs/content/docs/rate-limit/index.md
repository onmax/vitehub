---
title: Rate Limit
navigation.title: Overview
description: Require request budgets through an event-first H3 guard and atomic drivers.
navigation.order: 1
icon: i-lucide-gauge
---

::product-hero{tagline="Cap requests by client, user, account, or tenant with one guard in the handler. The selected driver consumes each unit atomically, in process memory on Node and through Cloudflare Rate Limiting on Cloudflare."}

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

::

::product-feature{label="Server API" title="A limited request gets a 429 from the guard" to="/docs/rate-limit/server-api" link-label="Read the Rate Limit server API"}
`requireRateLimit()` resolves when the request is allowed. Otherwise it throws a standard H3 `HTTPError`: status `429` when limited and status `503` when fail-closed enforcement is unavailable. It adds `retry-after` only when the driver supplies `retryAfter`.

The budget uses the client address by default. Pass `key` when a user, account, tenant, or API client is the correct boundary. The ID and the policy must be static literals because ViteHub generates provider configuration before runtime.

#code
```ts
await requireRateLimit(event, 'image-upload', {
  enforcement: 'best-effort',
  failure: 'deny',
  key: authenticatedUser.id,
  limit: 10,
  window: '1m',
})
```
::

::product-feature{label="Direct limiter" title="Read the decision when you need your own response" to="/docs/rate-limit/server-api" link-label="Build a direct limiter" reverse}
`createRateLimiter()` returns a limiter. Its `consume()` returns the decision and does not throw when the request is limited. Use it for a custom response, explicit logging, or another transport.

Do not build a limit with a KV `get()` followed by `set()`. Concurrent requests can read the same value. A custom driver must implement atomic `consume()` for its backend.

#code
```ts
import { createRateLimiter } from '@vite-hub/rate-limit'
import { memoryRateLimitDriver } from '@vite-hub/rate-limit/drivers/memory'

const limiter = createRateLimiter({
  driver: memoryRateLimitDriver(),
  enforcement: 'strict',
  limit: 2,
  window: '1m',
})

const decision = await limiter.consume({ key: 'demo' })
```
::

::product-feature{label="Configure" title="The preset selects the driver" to="/docs/rate-limit/get-started" link-label="Guard a first handler"}
The `node` preset uses process-local memory, also during local Vite development. The `cloudflare` preset uses Cloudflare Rate Limiting. The `vercel`, `netlify`, and `deno` presets reject `rateLimit`.

Use `hubRateLimit` from `@vite-hub/rate-limit/vite` to register the integration without the framework preset.

#code
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ preset: "node", rateLimit: true })],
})
```
::

::product-feature{label="Agent capability" title="Budget each Agent Invocation before it runs" to="/docs/rate-limit/agent-capability" link-label="Limit Agent Invocations" reverse}
`rateLimit()` consumes one budget unit before the main Agent Invocation starts. It derives the key from trusted Agent identity and calls the limiter exactly once.

A rejected decision throws `RATE_LIMIT_REJECTED`, and the HTTP handler maps it to `429`. The Agent Invocation does not run.

#code
```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { rateLimit } from 'vite-hub/agent/capabilities'
import { createRateLimiter } from '@vite-hub/rate-limit'
import { memoryRateLimitDriver } from '@vite-hub/rate-limit/drivers/memory'

const invocations = createRateLimiter({
  driver: memoryRateLimitDriver(),
  limit: 20,
  window: '1m',
})

export default defineAgent({
  driver: { model },
  capabilities: [
    rateLimit({
      limiter: invocations,
    }),
  ],
})
```
::

::product-feature{label="Hosts" title="The build records what each provider guarantees" to="/docs/rate-limit/hosts" link-label="See host and provider notes"}
The integration writes `.vitehub/rate-limit/manifest.json` with the enforcement, counter scope, and supported windows of each Rate Limit. Application code keeps using the guard.

Cloudflare native enforcement is best-effort and exposes only 10-second and 60-second windows. Incompatible policies fail during the build. Read [Limits and errors](/docs/rate-limit/limits-and-errors) for what Rate Limit does not guarantee.

#code
```json [.vitehub/rate-limit/manifest.json]
{
  "schemaVersion": 2,
  "rateLimits": [
    {
      "name": "image-upload",
      "provider": "cloudflare",
      "capabilities": {
        "enforcement": "best-effort",
        "rejectedAttempts": "unknown",
        "scope": "location",
        "windows": [10000, 60000]
      }
    }
  ]
}
```
::
