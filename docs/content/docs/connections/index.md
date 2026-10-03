---
title: Connections
navigation.title: Overview
description: Connect provider accounts with OAuth 2 or an API key, call their APIs with access rules, and record how routes and Agents use them.
navigation.order: 1
icon: i-lucide-plug
---

::product-hero{tagline="Call provider APIs as an app-owned account: OAuth 2 or API key, sealed in the app database, checked per call."}
  :::code-group
  ```ts [Route]
  import { useConnection } from 'vite-hub/connections/server'

  export default defineEventHandler(async (event) => {
    const connection = useConnection('google')
    return await connection.gmail.users.labels.list()
  })
  ```

  ```ts [Definition]
  import { useServerEnv } from '#vitehub/env/server'
  import { defineConnection } from 'vite-hub/connections'
  import { google } from 'vite-hub/connections/google'

  export default defineConnection({
    provider: google({
      clientId: () => useServerEnv().google.clientId,
      clientSecret: () => useServerEnv().google.clientSecret.unseal(),
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    }),
    access: {
      server: { write: ['gmail.*'] },
      agents: {
        labeller: { write: ['gmail.messages.*', 'gmail.labels.list', 'gmail.drafts.create'], approve: true },
      },
    },
  })
  ```

  ```ts [API key]
  import { apiKey, defineConnection } from 'vite-hub/connections'

  export default defineConnection({
    provider: apiKey({ id: 'executor', origins: ['https://executor.sh'] }),
  })
  ```

  ```bash [CLI]
  vitehub connections list
  vitehub connections status google
  vitehub connections activity google
  vitehub connections connect google
  vitehub connections refresh google
  printf %s "$EXECUTOR_API_KEY" | vitehub connections set-key executor
  ```
  :::
::

::product-features
  :::product-feature-item{title="Writes are denied until a rule allows them" icon="i-lucide-shield-check" to="/docs/connections/configure#access-rules" link-label="Connections access rules"}
  Each rule sets `read`, `write`, and `approve`; with an `access` map, actors without a matching rule are denied.
  :::

  :::product-feature-item{title="The credential goes only to declared origins" icon="i-lucide-shield-alert" to="/docs/connections/configure#provider-origins" link-label="Provider origins"}
  A request to another origin fails with `CONNECTIONS_ORIGIN_NOT_ALLOWED`, is recorded as denied, and does not receive the credential.
  :::

  :::product-feature-item{title="API keys get the same rules and activity" icon="i-lucide-key-round" to="/docs/connections/configure#api-key-connections" link-label="API key Connections"}
  `apiKey()` seals a static key like an OAuth grant, and an admin sets it at runtime in the Console or CLI.
  :::

  :::product-feature-item{title="Every write, denial, and failure is recorded" icon="i-lucide-activity" to="/docs/connections/server-api" link-label="Connections server API"}
  Activity records the actor, Operation id, outcome, and provider status, and never request bodies, response bodies, headers, or tokens.
  :::

  :::product-feature-item{title="Agents call it under their own rule" icon="i-lucide-bot" to="/docs/agents/capabilities/gmail" link-label="Gmail Capability"}
  An `approve` match fails server code with `CONNECTIONS_APPROVAL_REQUIRED` and makes an Agent tool ask for approval.
  :::

  :::product-feature-item{title="Not for static secrets without access rules" icon="i-lucide-git-branch" to="/docs/env" link-label="Compare Env"}
  Use Env for static secrets that do not need access rules, approvals, or activity.
  :::
::
