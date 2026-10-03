---
title: Connections get started
description: Enable Connections, define a Connection, connect the account, and call the provider.
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

## Quick start

::steps{level="3"}

### Configure

Connections need [Database](/docs/database) and a 32-byte encryption key.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', console: true, database: true, connections: true })],
})
```

```bash [Terminal]
# 32 random bytes, base64url
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Set the result as the secret `VITEHUB_CONNECTIONS_KEY` on the host. If the key changes, every Connection must be connected again.

### Define a Connection

The file name is the Connection name. `google()` adds the `openid` and `email` scopes to show the connected account. Register an OAuth client at the provider with the redirect URI `<origin>/_vitehub/connections/<name>/callback`.

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

### Connect the account

Open the Console, select **Connections**, and select **Connect**. You can also print a single-use connect URL from the CLI while the development server runs:

```bash [Terminal]
vitehub connections connect google
```

### Call the provider

```ts [server/api/labels.get.ts]
import { useConnection } from 'vite-hub/connections/server'

export default defineEventHandler(async (event) => {
  const connection = useConnection('google')
  return await connection.gmail.users.labels.list()
})
```

::
