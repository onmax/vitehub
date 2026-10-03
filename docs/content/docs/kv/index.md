---
title: KV
navigation.title: Overview
description: Store and retrieve small values by key through one key-value API.
navigation.order: 1
icon: i-lucide-database-zap
---

::product-hero{tagline="One key-value import for settings, flags, cursors, and cache records, on every supported host." providers="File system, Cloudflare KV, Upstash, Vercel, Deno KV"}
  :::code-group
  ```ts [Route]
  import { kv } from '@vite-hub/kv'

  const preferences = kv.store('tenant-preferences')

  export default defineEventHandler(async (event) => {
    const tenantId = getRouterParam(event, 'tenant')!
    const [readError, current] = await preferences.get(tenantId)
    if (readError) throw readError

    const [writeError] = await preferences.set(tenantId, { ...current, ...(await readBody(event)) })
    if (writeError) throw writeError
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

::product-flow{caption="kv.set() resolves to [error, value] on every host; the route never names the driver."}
  :::product-flow-step{label="Route" detail="kv.set('settings', body)"}
  :::
  :::product-flow-step{label="Runtime helper" detail="@vite-hub/kv"}
  :::
  :::product-flow-step{label="Driver" detail="fs-lite · cloudflare-kv · upstash"}
  :::
  :::product-flow-step{label="Store" detail="default or kv.store(name)"}
  :::
  :::product-flow-step{label="Result" detail="[error, value]"}
  :::
::

::product-features
  :::product-feature-item{title="Every call returns a result, not a throw" icon="i-lucide-code-2" to="/docs/kv/server-api"}
  `[error, value]` on every method, with the provider cause attached.
  :::

  :::product-feature-item{title="Pick the driver once, keep the import" icon="i-lucide-sliders-horizontal" to="/docs/kv/configure"}
  File system, Cloudflare KV, Upstash, Vercel, or Deno KV behind one import.
  :::

  :::product-feature-item{title="Named stores keep tenants apart" icon="i-lucide-database-zap" to="/docs/kv/configure#configuration-options"}
  Declare stores in config, select one with `kv.store(name)`.
  :::

  :::product-feature-item{title="The same store, as a tool for an Agent" icon="i-lucide-bot" to="/docs/kv/agent-capability"}
  `kv_read` and `kv_edit` tools, limited to one store, gated by policy.
  :::

  :::product-feature-item{title="Read and write the running app's store from a terminal" icon="i-lucide-terminal" to="/docs/kv/hosts"}
  The CLI uses the app's storage; the build emits the host binding.
  :::

  :::product-feature-item{title="Not for relations, large objects, or file trees" icon="i-lucide-git-branch" to="/docs/database"}
  Use Database, Blob, or Workspace for those.
  :::
::
