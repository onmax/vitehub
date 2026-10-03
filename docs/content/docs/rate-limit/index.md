---
title: Rate Limit
navigation.title: Overview
description: Require request budgets through an event-first H3 guard and atomic drivers.
navigation.order: 1
icon: i-lucide-gauge
---

Use Rate Limit before expensive server work to cap requests by client, user, account, or tenant. The selected driver consumes one unit atomically and reports whether the request can continue.

Don't build this with a KV `get()` followed by `set()`. Concurrent requests can read the same value. Rate Limit accepts drivers that implement atomic `consume()` for their backend.

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

## Next steps

- [Get started](/docs/rate-limit/get-started): register the integration and guard a first handler.
- [Server API](/docs/rate-limit/server-api): `requireRateLimit()`, public imports, decisions, and direct drivers.
- [Agent capability](/docs/rate-limit/agent-capability): consume a budget before an Agent Invocation starts.
- [Hosts](/docs/rate-limit/hosts): the generated manifest and Cloudflare deployment.
- [Limits and errors](/docs/rate-limit/limits-and-errors): what Rate Limit does not guarantee.

## Related

- [Cloudflare Provider Output](/docs/frameworks-hosts/cloudflare)
- [Import paths](/docs/reference/import-paths)
