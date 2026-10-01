# @vite-hub/connections

`@vite-hub/connections` stores one OAuth grant per Connection and lets server code call the provider API with typed methods. Each call applies the Connection access rules, can wait for approval, and is recorded as Env Bridge activity. Application code never reads the token.

Install this owner package alongside `vite-hub` and use `@vite-hub/connections` imports. The owner plugin provides Connection discovery and management for Vite applications.

## Install the owner package

```sh
pnpm add @vite-hub/connections drizzle-orm
```

The package requires Node.js 24 or newer. Vite is an optional peer and is needed only for Connection Definition discovery. The default store needs `drizzle-orm` and a SQLite Drizzle database.

## Define a Connection

```ts
// server/connections/google.ts
import { defineConnection } from "@vite-hub/connections";
import { google } from "@vite-hub/connections/google";

export default defineConnection({
  provider: google({
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
  }),
  scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  api: { gmail: ["users.labels.*", "users.messages.list", "users.messages.modify"] },
  access: {
    "schedule:gmail": { read: true, write: ["gmail.users.messages.modify"] },
    "agent:labeller": { read: true, write: "approve" },
  },
});
```

## Call the API

```ts
import { useConnection } from "@vite-hub/connections/server";

const gmail = useConnection("google", { actor: "schedule:gmail" }).gmail;
const { labels = [] } = await gmail.users.labels.list({ userId: "me" });
```

The client exposes only the methods selected in `api`. GET methods are reads and other methods are writes. Denied calls throw `ConnectionError` with code `CONNECTION_DENIED`. Writes that need approval throw `CONNECTION_APPROVAL_REQUIRED` and create an approval.

## Use a custom store

`useConnection()` uses the ViteHub Database and `VITEHUB_CONNECTIONS_KEY` by default. Call `setConnectionsRuntime()` to use another database or key:

```ts
import { createDatabaseConnectionStore, setConnectionsRuntime } from "@vite-hub/connections/server";

setConnectionsRuntime({
  definitions: { google: () => import("./server/connections/google.ts") },
  store: createDatabaseConnectionStore({ db, encryptionKey }),
});
```

Rejected or superseded OAuth callbacks do not revoke their issued token at the provider. A provider can revoke the whole application grant, which would also invalidate the winning token. The rejected token is not stored.

The default store serializes authorization-code exchange and persistence, token refresh, and provider revocation through one durable per-Connection mutation lease shared by all runtimes. Callback exchange waits until grant-wide revocation has finished. Waiting refresh callers read the replacement token instead of sending the same rotating grant again. Provider requests have a 30-second abort signal and a 60-second lease.

An expired unresolved lease blocks every token revision. A replacement token cannot prove that an earlier provider request has stopped. Confirm the provider outcome before repairing the lease in the application's store, then connect again. The default SQLite store exposes lease metadata in `vitehub_connection_refresh_leases`, with `name`, `owner`, `revision`, and `expires_at` columns. Inspect those columns without reading secrets. After confirming that the former operation can no longer affect the provider grant, remove only the matching `name` and `owner` row. Do not delete a lease solely because it expired. A request that settles normally releases its own lease.

Custom stores must implement atomic `refreshLeases.claim()` and owner-fenced `refreshLeases.release()`. The name remains for compatibility, but the lease covers all token mutations. `claim()` returns `acquired`, `busy`, or `expired`; it must never replace an expired unresolved lease, even when the token revision changed. A lost refresh response or failed token write requires reconnecting rather than reusing the old grant. An unconfirmed callback exchange or revoke keeps its lease until the provider outcome is confirmed and the store is repaired.

A custom Connections store must supply the token revision as the second `bridge.use()` callback argument. Revocation uses that revision to replace the token with a revoked marker. The default Env Bridge supplies it.

## Vite integration

`hubConnections()` from `@vite-hub/connections/vite` discovers `server/connections/*.ts` and `*.connection.ts`, generates the registry and types, mounts the management API in development, and adds the `vitehub connections` CLI.

| Option | Default | Meaning |
| --- | --- | --- |
| `database` | `false` | Module that exports the SQLite Drizzle database as `db`. |
| `management` | `false` | Use `{ actor: "./server/connections-auth.ts" }` to mount the production API with an authentication module. `true` is supported only in development. |
| `projectRoot` | Vite root | Project root for discovery. |

The actor module must default-export a function that authenticates the `Request` and returns `user:<id>` for an authorized manager. Return `undefined` to reject the request. Relative module paths resolve from the project root. The handler checks every API request and OAuth callback. Console authentication does not protect these routes automatically.

```ts
import { hubConnections } from "@vite-hub/connections/vite";

hubConnections({ management: { actor: "./server/connections-auth.ts" } });
```

Development uses `user:local` when no actor module is configured. A directly mounted `createConnectionsHandler()` also requires an `actor` callback and denies requests by default.

## Generate API catalogs

`pnpm --dir packages/connections run generate` reads the Google Discovery document and writes `src/google/gmail.ts`.

See the [Connections documentation](https://vitehub.dev/docs/server-primitives/connections).

Connection stores must implement `state.putForToken(state, revision)` as an atomic write that succeeds only while the encrypted token has that revision. A `null` revision requires the token to be absent. OAuth, refresh, and revocation use this check so older work cannot replace newer Connection metadata.
