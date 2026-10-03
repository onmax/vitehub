---
title: KV
navigation.title: Overview
description: Store and retrieve small values by key through one key-value API.
navigation.order: 1
icon: i-lucide-database-zap
---

::product-hero{tagline="One key-value API for settings, feature flags, cursors, cache records, and other small values. Your route calls it in development and on every supported host."}

```ts [server/api/settings.put.ts]
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async (event) => {
  const [error] = await kv.set('settings', await readBody(event))
  if (error) throw error
  return { ok: true }
})
```

::

::product-feature{label="Server API" title="Every call returns a result, not a throw" to="/docs/kv/server-api" link-label="Read the KV server API"}
Each async method returns `[error, value]`. A provider failure is a `ViteHubError` with the operation, the store, and the provider cause. Log it, retry it, or translate it without `try/catch`.

Named stores keep tenant data apart. Upstash adds atomic single-use reads and counters.

#code
```ts [server/tenant-preferences.ts]
import { kv } from '@vite-hub/kv'

const preferences = kv.store('tenant-preferences')

export async function savePreferences(tenantId: string, value: unknown) {
  const [error] = await preferences.set(tenantId, value)
  if (error) throw error
}

const [consumeError, token] = await kv.getAndDelete('verification:token')
const [incrementError, attempts] = await kv.increment('rate-limit:user', 60)
```
::

::product-feature{label="Configure" title="Pick the driver once, keep the import" to="/docs/kv/configure" link-label="Configure KV stores and drivers" reverse}
Register the Vite integration and select a driver. Local development uses the file system. Cloudflare KV, Upstash, Vercel, and Deno KV take the same `kv` import, so the route never names a provider.

Define extra stores when one application needs separate namespaces.

#code
```ts [vite.config.ts]
import { hubKv } from '@vite-hub/kv/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubKv()],
  kv: {
    stores: {
      'default': { driver: 'fs-lite' },
      'tenant-preferences': { driver: 'upstash' },
    },
  },
})
```
::

::product-feature{label="Agent capability" title="The same store, as a tool for an Agent" to="/docs/kv/agent-capability" link-label="Give an Agent KV tools"}
Installing KV gives no model access to it. Attach the KV Capability to hand an Agent a `kv_read` tool, and in write mode a `kv_edit` tool, limited to one named store.

Write access can require approval before the Agent commits a change.

#code
```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { kv } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  capabilities: [
    kv({ mode: 'write', store: 'tenant-preferences', policy: 'require-approval' }),
  ],
})
```
::

::product-feature{label="Hosts" title="Inspect it from the CLI, ship it to any host" to="/docs/kv/hosts" link-label="See host and provider notes" reverse}
The development CLI reads and writes the same stores as the running app. The build emits the binding, environment variable, or local path that the selected host needs.

Use [Database](/docs/database) when data needs relationships, [Blob](/docs/blob) for large objects, and [Workspace](/docs/workspace) for file trees.

#code
```bash [Terminal]
pnpm vitehub kv list --prefix users:
pnpm vitehub kv get settings --json
pnpm vitehub kv set settings '{"theme":"dark"}' --json-value
pnpm vitehub kv list --store tenant-preferences
```
::
