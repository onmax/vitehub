---
title: Env
navigation.title: Overview
description: Declare public, build-time, server runtime, and secret values behind typed ViteHub accessors.
navigation.order: 1
icon: i-lucide-key-round
---

::product-hero{tagline="Declare browser-safe values, build replacements, server-only values, and secrets in the Vite config. ViteHub generates typed imports for each, and Secret Env values stay redacted until server code calls unseal()."}

```ts [server/github.ts]
import { useServerEnv } from '#vitehub/env/server'

export async function listIssues() {
  const { github } = useServerEnv()

  return fetch('https://api.github.com/issues', {
    headers: {
      authorization: `Bearer ${github.token.unseal()}`,
    },
  })
}
```

::

::product-feature{label="Configure" title="Host strings become typed values" to="/docs/env/configure" link-label="Declare Env values"}
`env.public` becomes browser-safe Public Env, `env.define` becomes Vite replacements, and `env.server` becomes Server Env. Each declaration selects its source, default, and secret flag.

`env.boolean()`, `env.number()`, and `env.enum()` parse the value and generate the exact type. An invalid value fails with `ENV_RUNTIME_VALUE_INVALID`, and the error never contains the value.

#code
```ts [vite.config.ts]
import { env, hubEnv } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubEnv()],
  env: {
    server: {
      labeller: {
        dryRun: env.boolean({ default: true }),
        minConfidence: env.number({ default: 0.6 }),
        mode: env.enum(['draft', 'send'], { default: 'draft' }),
        apiKey: env({ secret: true }),
      },
    },
  },
})
```

```ts [server/labeller.ts]
import { useServerEnv } from '#vitehub/env/server'

const { labeller } = useServerEnv()
if (!labeller.dryRun && labeller.mode === 'send') {
  // labeller.minConfidence is a number.
}
```
::

::product-feature{label="Public Env" title="Browser code reads Public Env from one stable import" to="/docs/env/server-api" link-label="Read the Env server API" reverse}
ViteHub generates the backing module. Application code imports `#vitehub/env/public` and `#vitehub/env/server`, not generated file paths.

Public Env and define values are visible in built client code. Put secrets only in Server Env with `secret: true`.

#code
```ts [src/config.ts]
import { usePublicEnv } from '#vitehub/env/public'

export const appName = usePublicEnv().appName
```
::

::product-feature{label="Providers" title="Read credentials from external storage at each operation" to="/docs/env/server-api#read-external-env-storage" link-label="Read external Env storage"}
An Env provider reads application-owned credentials that live outside the host environment. Declare only the keys the application uses.

`loadServerEnv()` returns a new frozen snapshot on each call, so a rotated value is visible to the next load.

#code
```ts [vite.config.ts]
import { env, hubEnv } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubEnv({
    providers: {
      credentials: './server/env/credentials.ts',
    },
  })],
  env: {
    server: {
      githubToken: env({
        secret: true,
        source: env.provider('credentials', 'github/token'),
      }),
    },
  },
})
```

```ts [server/sources/private-repository.ts]
import { loadServerEnv } from '#vitehub/env/server'
import { github } from 'vite-hub/workspace'

export const privateRepository = github(async () => {
  const env = await loadServerEnv()
  return {
    auth: env.githubToken.unseal(),
    repo: 'acme/private-repository',
  }
})
```
::

::product-feature{label="Inspection" title="Check a stage before you deploy, without printing values" to="/docs/development/cli#inspect-server-env" link-label="Inspect Server Env from the CLI" reverse}
`env inspect` lists each declared variable with its status, source, required flag, and secret flag. `env check` exits with `1` when Server Env would not load, so it can gate CI and deploy steps.

The Console Env section shows the same status.

#code
```bash [Terminal]
pnpm vitehub env inspect [--stage <name>] [--json]
pnpm vitehub env check [--stage <name>] [--json]
```
::

::product-feature{label="Env Bridge" title="Replace a credential without a redeploy" to="/docs/env/bridge" link-label="Set up Env Bridge"}
Env Bridge is an Env provider with a secret store, per-key grants, and a durable activity log. A user, Agent, or service gets only the permissions you grant for that key. Host variables stay read-only.

A replacement with a stale revision fails with `ENV_BRIDGE_CONFLICT`. Use [Connections](/docs/connections) for OAuth tokens of connected accounts.

#code
```ts
// owner is an EnvAccessContext returned by your server authentication policy.
await bridge.replace(owner, {
  key: 'github/token',
  value: newToken,
  expectedRevision: null,
})
await bridge.grant(owner, {
  actor: { kind: 'service', id: 'application' },
  key: 'github/token',
  permissions: ['use'],
})
```
::
