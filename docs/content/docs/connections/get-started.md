---

title: Connect your first provider account
description: Install Connections, define a Google account, connect it, and call the provider.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Connections stores an OAuth grant in your application database and checks an
access rule before every provider call. This tutorial uses Gmail labels because
the first successful call has a small, inspectable response.

::note
You need Node.js 24.15 or newer, `pnpm`, a Google OAuth client, and an existing
Vite server app. The app must have a Database integration and a stable
`VITEHUB_CONNECTIONS_KEY` secret.
::

::tutorial-step{title="Install and configure"}
## Install and configure

Install the ViteHub distribution:

```bash [commands/install]
pnpm add vite-hub
```

Connections need [Database](/docs/database), Env declarations for the Google
client, and a 32-byte encryption key.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', console: true, database: true, connections: true })],
  env: {
    server: {
      google: {
        clientId: env({ source: env.source('GOOGLE_CLIENT_ID') }),
        clientSecret: env({ secret: true, source: env.source('GOOGLE_CLIENT_SECRET') }),
      },
    },
  },
})
```

```bash [commands/secret]
# 32 random bytes, base64url
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Set the result as the secret `VITEHUB_CONNECTIONS_KEY` on the host. If the key changes, every Connection must be connected again.

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` too. In the Google Cloud
console, add `<origin>/_vitehub/connections/callback` as an authorized redirect
URI.

::

::tutorial-step{title="Define a Connection"}
## Define a Connection

The file name is the Connection name. `google()` adds the `openid` and `email` scopes to show the connected account. Register an OAuth client at the provider with the redirect URI `<origin>/_vitehub/connections/callback`.

```ts [server/connections/google.ts]
import { useServerEnv } from '#vitehub/env/server'
import { defineConnection } from 'vite-hub/connections'
import { google } from 'vite-hub/connections/google'

export default defineConnection({
  provider: google({
    clientId: () => useServerEnv().google.clientId,
    clientSecret: () => useServerEnv().google.clientSecret.unseal(),
  }),
  scopes: ['https://www.googleapis.com/auth/gmail.modify'],
  access: {
    server: { write: ['gmail.*'] },
    agents: {
      labeller: { write: ['gmail.messages.*', 'gmail.labels.list', 'gmail.drafts.create'], approve: true },
    },
  },
})
```

::

::tutorial-step{title="Connect the account"}
## Connect the account

Open the Console, select **Connections**, and select **Connect**. You can also print a single-use connect URL from the CLI while the development server runs:

```bash [commands/connect]
pnpm vite dev
pnpm vitehub connections connect google
pnpm vitehub connections status google --json
```

The status should report a connected account.
::

::tutorial-step{title="Call the provider"}
## Call the provider

```ts [server/api/labels.get.ts]
import { defineEventHandler } from 'h3'
import { useConnection } from 'vite-hub/connections/server'

export default defineEventHandler(async (event) => {
  const connection = useConnection('google')
  return await connection.gmail.users.labels.list({ userId: 'me' })
})
```

Request the route and verify that
the provider returns a `labels` array:

```bash [commands/request]
curl http://localhost:5173/api/labels
```

```json [output/response.json]
{ "labels": [] }
```

Gmail may return system labels, so the array is not always empty. Read [Server
API](/docs/connections/server-api) for access rules, approvals, and API-key
Connections.
::
