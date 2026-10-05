---
title: Connections server API
description: Call a Connection from server code, read its activity, and manage Connections from the CLI.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `defineConnection`, `oauth2`, `apiKey`, `useConnection` from `vite-hub/connections` | Define a Connection, use a generic OAuth 2 or API key provider, and call a Connection from server code. |
| `google`, `gmail`, `gmailOperations` from `vite-hub/connections/google` | Google OAuth preset and typed Gmail REST Operations. |
| `createConnectionsRuntime`, `useConnectionsRuntime` from `vite-hub/connections/server` | Runtime access for hosts and tests. |
| `createConnectionsHandler` from `vite-hub/connections/http` | Management, connect, and callback routes. The Console mounts them. |
| `hubConnections` from `@vite-hub/connections/vite` | Standalone Vite integration. |

## Calls

`useConnection(name, options)` returns a client:

| Method | Behavior |
| --- | --- |
| `call(operation, input)` | Runs a typed Operation. An Operation has an `id`, an `effect` (`read` or `write`), and a `request(input)` builder. |
| `fetch(url, init)` | Sends a request with the access token. `GET` and `HEAD` are reads with the id `fetch.get` or `fetch.head`. Other methods are writes. |
| `status()` | Returns the Connection summary without tokens. |

Each call checks access, gets a valid access token, and sends the request. ViteHub refreshes the token 60 seconds before it expires. When the provider returns `401`, ViteHub refreshes once and retries once. When the provider rejects the refresh token, the status changes to `needs-reconnect`.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `event` | None | The request event. The route becomes the actor, for example `GET /api/labels`. |
| `actor` | Route from `event`, else `{ id: 'server', kind: 'service' }` | The actor for access rules and activity. |
| `dryRun` | `false` | Write Operations return `{ skipped: 'dry-run', operation }` and do not call the provider. `fetch` returns `204` with the `x-vitehub-connection-skipped` header. |
| `audit` | `'changes'` | `'changes'` records writes, denials, skipped calls, and failures. `'all'` also records reads. |
| `signal` | None | Cancels token refresh, refresh-lease waits, and the Operation request, including its response body. |
| `trace` | None | `traceId`, `invocationId`, `runId`, and `tool` to link activity to a trace. |

## Activity

ViteHub stores activity in the `vitehub_connection_activity` table. Each entry has the actor, action (`call`, `connect`, `refresh`, `disconnect`), Operation id, effect, outcome, provider status, duration, target host and path, and trace ids. Activity never contains request bodies, response bodies, headers, or tokens.

Agent tools record every call, reads included. MCP protocol messages record successful, denied, and failed requests. The Console shows activity for each Connection.

## CLI

The CLI calls the management route of a running development server with the Console enabled. `--url` defaults to `VITEHUB_DEV_SERVER_URL`, then `http://localhost:5173`.

| Command | Description |
| --- | --- |
| `vitehub connections list` | List Connections and their status. |
| `vitehub connections status <name>` | Show one Connection. |
| `vitehub connections activity [name]` | Show recent activity. |
| `vitehub connections connect <name>` | Print a single-use connect URL. |
| `vitehub connections set-key <name>` | Store the key of an API key Connection from stdin. |
| `vitehub connections refresh <name>` | Refresh the access token now. |
| `vitehub connections disconnect <name>` | Revoke the grant at the provider and delete it. If revocation fails, ViteHub still deletes the local grant and records the error in the `disconnect` activity. Revoke the app at the provider then. |
