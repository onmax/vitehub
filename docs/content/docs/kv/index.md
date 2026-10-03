---
title: KV
navigation.title: Overview
description: Store and retrieve small values by key through one key-value API.
navigation.order: 1
icon: i-lucide-database-zap
---

::product-hero{tagline="One key-value import for settings, flags, cursors, and cache records, on every supported host."}
  :::code-group
  ```ts [Route]
  import { kv } from '@vite-hub/kv'

  export default defineEventHandler(async (event) => {
    const [error] = await kv.set('settings', await readBody(event))
    if (error) throw error
    return { ok: true }
  })
  ```

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

  ```ts [Agent]
  import { defineAgent } from 'vite-hub/agent'
  import { kv } from 'vite-hub/agent/capabilities'

  export default defineAgent({
    driver: { model: 'openai/gpt-5.1-mini' },
    capabilities: [
      kv({ mode: 'write', store: 'tenant-preferences', policy: 'require-approval' }),
    ],
  })
  ```

  ```bash [CLI]
  pnpm vitehub kv list --prefix users:
  pnpm vitehub kv get settings --json
  pnpm vitehub kv set settings '{"theme":"dark"}' --json-value
  pnpm vitehub kv list --store tenant-preferences
  ```
  :::
::

::product-features
  :::product-feature-item{title="Every call returns a result, not a throw" icon="i-lucide-code-2" to="/docs/kv/server-api" link-label="KV server API"}
  Each method returns `[error, value]`, with the operation, the store, and the provider cause on the error.
  :::

  :::product-feature-item{title="Pick the driver once, keep the import" icon="i-lucide-sliders-horizontal" to="/docs/kv/configure" link-label="Configure KV"}
  The file system in development; Cloudflare KV, Upstash, Vercel, or Deno KV in production, behind the same `kv` import.
  :::

  :::product-feature-item{title="Named stores keep tenants apart" icon="i-lucide-database-zap" to="/docs/kv/configure#configuration-options" link-label="Define named stores"}
  Declare extra stores in config and select one with `kv.store(name)`. Upstash adds atomic counters and single-use reads.
  :::

  :::product-feature-item{title="The same store, as a tool for an Agent" icon="i-lucide-bot" to="/docs/kv/agent-capability" link-label="KV Agent capability"}
  The KV Capability gives an Agent `kv_read`, and in write mode `kv_edit`, limited to one named store and gated by a policy.
  :::

  :::product-feature-item{title="Read and write the running app's store from a terminal" icon="i-lucide-terminal" to="/docs/kv/hosts" link-label="KV hosts and CLI"}
  The development CLI uses the same storage as the app. The build emits the binding, variable, or path the host needs.
  :::

  :::product-feature-item{title="Not for relations, large objects, or file trees" icon="i-lucide-git-branch" to="/docs/database" link-label="Compare Database"}
  Use Database when data needs constraints, Blob for large objects, and Workspace for file trees.
  :::
::
