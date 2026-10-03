---
title: KV
navigation.title: Overview
description: Store and retrieve small values by key through one key-value API.
navigation.order: 1
icon: i-lucide-database-zap
---

Use KV for settings, feature flags, cursors, cache records, and other small values addressed by key.

Use [Database](/docs/database) when data needs relationships or constraints, [Blob](/docs/blob) for large objects, and [Workspace](/docs/workspace) for file trees.

This server route writes one key to the Default KV Store:

```ts [server/api/settings.put.ts]
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async (event) => {
  const [error] = await kv.set('settings', await readBody(event))
  if (error) throw error
  return { ok: true }
})
```

## Connect KV to Agents

Direct KV access is for app and server code. To let a model inspect or edit scoped key-value data, attach the [KV Capability](/docs/kv/agent-capability).

```bash [Terminal]
pnpm add @vite-hub/agent
```

```ts [server/agents/support/agent.ts]
import { kv } from '@vite-hub/agent/capabilities'
```

Give model-facing tools the narrowest useful key prefix and configure write access deliberately. Read [Official capabilities](/docs/agents/capabilities/official) for storage modes and write approvals.

## Next steps

- [Get started](/docs/kv/get-started): install KV and write the first key.
- [Configure](/docs/kv/configure): select drivers and define named KV Stores.
- [Server API](/docs/kv/server-api): read and write keys from server code.
- [Agent capability](/docs/kv/agent-capability): give an Agent scoped KV tools.
- [Hosts](/docs/kv/hosts): provider output, the development CLI, and production checks.
- Use [Database](/docs/database) for relational data.
- Use [Blob](/docs/blob) for object storage.
- Expose scoped model access through [Official capabilities](/docs/agents/capabilities/official).
