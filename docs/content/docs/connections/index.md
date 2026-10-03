---
title: Connections
navigation.title: Overview
description: Connect provider accounts with OAuth 2 or an API key, call their APIs with access rules, and record how routes and Agents use them.
navigation.order: 1
icon: i-lucide-plug
---

Use Connections when server code or an Agent calls a provider API as one account that the app owns, for example one Gmail inbox.

A Connection Definition in code declares the provider, the OAuth scopes, and the access rules. The [Console](/docs/development/console) connects, reconnects, refreshes, and disconnects the account at runtime. ViteHub stores the grant sealed in the app database, refreshes the access token, checks access before each call, and records activity.

For a provider that gives a static API key, use an [API key Connection](/docs/connections/configure#api-key-connections) when access rules, approvals, and activity must apply to its calls. Use [Env](/docs/env) for other static secrets. Connections do not replace Auth: they do not sign in users.

```ts [server/api/labels.get.ts]
import { useConnection } from 'vite-hub/connections'
import { gmail } from 'vite-hub/connections/google'

export default defineEventHandler(async (event) => {
  const connection = useConnection('google', { event })
  return await gmail(connection).labels.list()
})
```

## Use from Agents

Agent Capabilities call a Connection with `agent:<name>` as the actor. The rule in `access['agent:<name>']` applies. Connections checks access before each request runs.

| Capability | Option | Operation ids |
| --- | --- | --- |
| [`gmail()`](/docs/agents/capabilities/gmail) | `connection`, default `'google'` | `gmail.users.messages.list`, `gmail.users.messages.get`, `gmail.users.messages.attachments.get`, `gmail.users.drafts.create` |
| [`openapi()`](/docs/agents/capabilities/openapi#authenticate-through-a-connection) | `connection` | `fetch` |
| [`mcp()`](/docs/agents/capabilities/mcp#authenticate-through-a-connection) | `servers.<name>.connection` | `fetch` |

Gmail drafts use the Connection action `gmail.users.drafts.create` as a write. Grant it with `write: ['gmail.users.drafts.create']` in the Agent rule. OpenAPI operations other than `GET` and `HEAD` and MCP POST requests use the Connection `fetch` action as writes, so they need `write: ['fetch']`. Without a matching write rule, these requests are denied. MCP also requires `approve: false` because its transport needs each response in the active session.
