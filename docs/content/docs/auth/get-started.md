---
title: Create your first Auth session
description: Install Auth, create a user, and verify a Better Auth session.
navigation.title: Tutorial
layout: tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Auth mounts Better Auth under one generated route and keeps session access in
server code. This tutorial enables email and password sign-up with the default
runtime store, then verifies the session with two requests.

::note
You need Node.js 24.15 or newer, `pnpm`, and an existing Vite server app. The
in-memory default proves the route only. Add a Better Auth database adapter
before relying on sessions across restarts or replicas.
::

::tutorial-step{title="Install and configure"}
## Install and configure

```bash [Terminal]
pnpm add @vite-hub/auth @vite-hub/runtime better-auth h3
pnpm add -D vite
```

Register the Auth integration:

```ts [vite.config.ts]
import { hubAuth } from '@vite-hub/auth/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubAuth()],
})
```

::

::tutorial-step{title="Define Auth"}
## Define Auth

Create `server/auth.ts`:

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  emailAndPassword: { enabled: true },
})
```

ViteHub discovers the definition and mounts Better Auth at `/api/auth/**`.

::

::tutorial-step{title="Create and verify one session"}
## Create and verify one session

Start the dev server. Sign up with an email and password, saving the session
cookie for the second request:

```bash [Terminal]
pnpm vite dev
curl -i -c cookies.txt -X POST http://localhost:5173/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  -d '{"name":"Ada Lovelace","email":"ada@example.com","password":"correct-horse-battery-staple"}'
```

A successful response is `200` and includes a user, a session, and a
`set-cookie` header. Read the session back with the saved cookie:

```bash [Terminal]
curl -i -b cookies.txt http://localhost:5173/api/auth/get-session
```

The JSON response includes the signed-in user and session expiry. The default
store is for discovery and local checks, not durable production sessions. Read
[Storage placement](/docs/auth/configure#storage-placement-metadata) before
adding a database adapter, and [Server API](/docs/auth/server-api) for route
guards.
::
