---
title: Rate Limit
navigation.title: Overview
description: Require request budgets through an event-first H3 guard and atomic drivers.
navigation.order: 1
icon: i-lucide-gauge
---

::product-hero{tagline="One guard caps requests per client, user, or tenant, with atomic drivers: memory on Node, Cloudflare Rate Limiting on Cloudflare."}
  :::code-group
  ```ts [Route]
  import { requireRateLimit } from 'vite-hub/rate-limit'

  export default defineEventHandler(async (event) => {
    await requireRateLimit(event, 'image-upload', {
      limit: 10,
      window: '1m',
    })
    return { ok: true }
  })
  ```

  ```ts [vite.config.ts]
  import { vitehub } from 'vite-hub'
  import { defineConfig } from 'vite'

  export default defineConfig({
    plugins: [vitehub({ preset: "node", rateLimit: true })],
  })
  ```

  ```ts [Limiter]
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

  ```ts [Agent]
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
  :::
::

::product-features
  :::product-feature-item{title="Limited requests get a 429 from the guard" icon="i-lucide-shield-alert" to="/docs/rate-limit/server-api" link-label="Rate Limit server API"}
  `requireRateLimit()` throws a `429` H3 `HTTPError`, and the budget uses the client address unless you pass `key`.
  :::

  :::product-feature-item{title="Read the decision for your own response" icon="i-lucide-code-2" to="/docs/rate-limit/server-api#use-a-direct-driver" link-label="Use a direct driver"}
  `createRateLimiter()` returns a limiter whose `consume()` returns the decision and does not throw when the request is limited.
  :::

  :::product-feature-item{title="The preset selects the driver" icon="i-lucide-sliders-horizontal" to="/docs/rate-limit/get-started" link-label="Rate Limit get started"}
  `node` uses process memory, `cloudflare` uses Cloudflare Rate Limiting, and `vercel`, `netlify`, and `deno` reject `rateLimit`.
  :::

  :::product-feature-item{title="Budget each Agent Invocation before it runs" icon="i-lucide-bot" to="/docs/rate-limit/agent-capability" link-label="Rate Limit capability"}
  `rateLimit()` consumes one unit before the Invocation starts, and a rejection throws `RATE_LIMIT_REJECTED`, which the handler maps to `429`.
  :::

  :::product-feature-item{title="The build records what each provider guarantees" icon="i-lucide-cloud-cog" to="/docs/rate-limit/hosts" link-label="Rate Limit hosts"}
  A generated manifest lists the enforcement, counter scope, and windows of each limit, and incompatible policies fail the build.
  :::

  :::product-feature-item{title="Not a KV get followed by set" icon="i-lucide-git-branch" to="/docs/kv" link-label="Compare KV"}
  Concurrent requests can read the same KV value, so use a Rate Limit driver with an atomic `consume()`.
  :::
::
