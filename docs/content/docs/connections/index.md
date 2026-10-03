---
title: Connections
navigation.title: Overview
description: Connect provider accounts with OAuth 2 or an API key, call their APIs with access rules, and record how routes and Agents use them.
navigation.order: 1
icon: i-lucide-plug
---

::product-hero{tagline="Call a provider API as one account that the app owns, through OAuth 2 or an API key. ViteHub seals the grant in the app database, refreshes the token, checks access before each call, and records activity."}

```ts [server/api/labels.get.ts]
import { useConnection } from 'vite-hub/connections'
import { gmail } from 'vite-hub/connections/google'

export default defineEventHandler(async (event) => {
  const connection = useConnection('google', { event })
  return await gmail(connection).labels.list()
})
```

::

::product-feature{label="Access rules" title="Writes are denied until a rule allows them" to="/docs/connections/configure" link-label="Write access rules"}
A Connection Definition declares the provider, the OAuth scopes, and the access rules. The file name is the Connection name. ViteHub checks `deny` first, then `approve`, then `allow`. When no pattern matches, reads are allowed and writes are denied.

An `approve` match makes server code fail with `CONNECTIONS_APPROVAL_REQUIRED`. An Agent tool asks for tool approval instead. The [Gmail Capability](/docs/agents/capabilities/gmail) calls a Connection under the rule of its Agent.

#code
```ts [server/connections/google.ts]
import { useServerEnv } from '#vitehub/env/server'
import { defineConnection } from 'vite-hub/connections'
import { google } from 'vite-hub/connections/google'

export default defineConnection({
  provider: google({
    client: ({ event }) => useServerEnv(event).google,
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
  }),
  access: {
    server: { allow: ['gmail.*'] },
    agents: {
      labeller: { allow: ['gmail.messages.*', 'gmail.labels.list'], approve: ['gmail.drafts.create'] },
    },
  },
})
```
::

::product-feature{label="Provider origins" title="The credential goes only to declared origins" to="/docs/connections/configure" link-label="Configure provider origins" reverse}
Each provider declares the API origins that may receive its credential. `google()` allows `https://*.googleapis.com`. Set `origins` for a generic `oauth2()` provider.

A request to any other origin fails with `CONNECTIONS_ORIGIN_NOT_ALLOWED`, and ViteHub records the attempt as denied. The credential is not sent.

#code
```ts [server/connections/crm.ts]
import { defineConnection, oauth2 } from 'vite-hub/connections'

export default defineConnection({
  provider: oauth2({
    authorizationUrl: 'https://crm.example.com/oauth/authorize',
    client: ({ event }) => useServerEnv(event).crm,
    id: 'crm',
    origins: ['https://api.crm.example.com'],
    scopes: ['contacts.read'],
    tokenUrl: 'https://crm.example.com/oauth/token',
  }),
})
```
::

::product-feature{label="API keys" title="A static key gets the same rules and activity" to="/docs/connections/configure" link-label="Define an API key Connection"}
`apiKey()` defines a Connection whose credential is a static key. An admin sets the key at runtime in the Console or through the CLI, so it is not in code or Server Env. The CLI reads the key only from stdin.

ViteHub seals the key like an OAuth grant. Use [Env](/docs/env) for other static secrets that do not need access rules, approvals, or activity.

#code
```ts [server/connections/executor.ts]
import { apiKey, defineConnection } from 'vite-hub/connections'

export default defineConnection({
  provider: apiKey({ id: 'executor', origins: ['https://executor.sh'] }),
})
```

```bash [Terminal]
printf %s "$EXECUTOR_API_KEY" | vitehub connections set-key executor
```
::

::product-feature{label="Activity" title="Every write, denial, and failure is recorded" to="/docs/connections/server-api" link-label="Read the Connections server API" reverse}
Each call checks access, gets a valid access token, and sends the request. ViteHub refreshes the token 60 seconds before it expires. After a `401`, it refreshes once and retries once.

Activity records the actor, Operation id, outcome, and provider status. It never contains request bodies, response bodies, headers, or tokens. The CLI reads it from a running development server with the [Console](/docs/development/console) enabled.

#code
```bash [Terminal]
vitehub connections list
vitehub connections status google
vitehub connections activity google
vitehub connections connect google
vitehub connections refresh google
```
::
