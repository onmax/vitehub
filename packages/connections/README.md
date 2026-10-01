# @vite-hub/connections

`@vite-hub/connections` stores one OAuth grant per Connection and lets server code call the provider API with typed methods. Each call applies the Connection access rules, can wait for approval, and is recorded as Env Bridge activity. Application code never reads the token.

Most ViteHub applications should install the `vite-hub` framework distribution and use its `vite-hub/connections` imports. Install this owner package directly when you build a library or a custom framework integration.

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

## Vite integration

`hubConnections()` from `@vite-hub/connections/vite` discovers `server/connections/*.ts` and `*.connection.ts`, generates the registry and types, mounts the management API in development, and adds the `vitehub connections` CLI.

| Option | Default | Meaning |
| --- | --- | --- |
| `actor` | none | Module whose default export receives the server event and returns `user:<id>`. Management actions record this actor. Without it, they record `user:local`. `vite-hub` sets it to the signed-in Console user. |
| `database` | `false` | Module that exports the SQLite Drizzle database as `db`. |
| `management` | `false` | Mount the management API in production. Protect it with authentication. |
| `projectRoot` | Vite root | Project root for discovery. |

CLI approval JSON output includes the stored write input. Approval execution JSON also includes the provider result. The Console requests approval summaries that omit both fields from browser responses.

## Generate API catalogs

`pnpm --dir packages/connections run generate` reads the Google Discovery document and writes `src/google/gmail.ts`.

See the [Connections documentation](https://vitehub.dev/docs/server-primitives/connections).
