---
title: Env
navigation.title: Overview
description: Declare public, build-time, server runtime, and secret values behind typed ViteHub accessors.
navigation.order: 1
icon: i-lucide-key-round
---

::product-hero{tagline="Declare public, build-time, server, and secret values in the Vite config, and read them through generated typed imports."}
  :::code-group
  ```ts [Server]
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

  ```ts [vite.config.ts]
  import { env, hubEnv } from '@vite-hub/env/vite'
  import { defineConfig } from 'vite'

  export default defineConfig({
    plugins: [hubEnv()],
    env: {
      server: {
        github: {
          token: env({ secret: true, source: env.source('GITHUB_TOKEN') }),
        },
        labeller: {
          dryRun: env.boolean({ default: true }),
          minConfidence: env.number({ default: 0.6 }),
          mode: env.enum(['draft', 'send'], { default: 'draft' }),
        },
      },
    },
  })
  ```

  ```bash [CLI]
  pnpm vitehub env inspect [--stage <name>] [--json]
  pnpm vitehub env check [--stage <name>] [--json]
  ```
  :::
::

::product-features
  :::product-feature-item{title="Host strings become typed values" icon="i-lucide-sliders-horizontal" to="/docs/env/configure" link-label="Configure Env"}
  `env.boolean()`, `env.number()`, and `env.enum()` parse each value, and an invalid one fails with `ENV_RUNTIME_VALUE_INVALID` without the value.
  :::

  :::product-feature-item{title="Secrets stay on the server, redacted" icon="i-lucide-shield-check" to="/docs/env/server-api" link-label="Env server API"}
  Public Env and define values ship in client code, while Secret Env stays in Server Env and redacted until `unseal()`.
  :::

  :::product-feature-item{title="Read credentials from external storage" icon="i-lucide-database" to="/docs/env/server-api#read-external-env-storage" link-label="Read external Env storage"}
  An Env provider reads application-owned credentials outside the host, and each `loadServerEnv()` call returns a new snapshot with rotated values.
  :::

  :::product-feature-item{title="Check a stage without printing values" icon="i-lucide-terminal" to="/docs/development/cli#inspect-server-env" link-label="Inspect Server Env from the CLI"}
  `env inspect` lists each variable's status and source, and `env check` exits with `1` when Server Env would not load.
  :::

  :::product-feature-item{title="Replace a credential without a redeploy" icon="i-lucide-key-round" to="/docs/env/bridge" link-label="Env Bridge"}
  Env Bridge is an Env provider with a secret store, per-key grants, and a durable activity log.
  :::

  :::product-feature-item{title="Not for connected account tokens" icon="i-lucide-plug" to="/docs/connections" link-label="Compare Connections"}
  Env holds application-owned credentials, so use Connections for the OAuth tokens of connected accounts.
  :::
::
