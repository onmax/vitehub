---
title: Auth
navigation.title: Overview
description: Configure Better Auth server behavior, route exposure, runtime options, and session checks.
navigation.order: 1
icon: i-lucide-shield-check
---

::product-hero{tagline="Better Auth sessions and server-side identity checks for a ViteHub app. ViteHub discovers one Auth Definition, mounts its route, and guards the routes you list."}

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  emailAndPassword: { enabled: true },
})
```

::

::product-feature{label="Server API" title="Read the session in any server route" to="/docs/auth/server-api" link-label="Read the Auth server API"}
ViteHub mounts Better Auth at `/api/auth/**`, so same-origin apps need no manual route file. Server code reads the discovered instance through `auth`, or guards a route with `requireAuth()`.

Vue code reads the same session through `useUserSession()`.

#code
```ts [server/api/me.get.ts]
import { auth } from '@vite-hub/auth/server'

export default defineEventHandler(async (event) => {
  const headers = new Headers(getRequestHeaders(event))

  return auth.api.getSession({ headers })
})
```
::

::product-feature{label="Access routes" title="List the routes to guard, and decide roles in a callback" to="/docs/auth/server-api#authorize-access-routes" link-label="Authorize access routes" reverse}
Generated middleware guards every route in `access.routes`. `authorize` runs only after authentication. It returns `true` to continue, `false` for `403`, or a `Response`.

ViteHub defines no admin role. Map your own role or permission model in the callback.

#code
```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  access: {
    routes: [
      {
        route: '/_vitehub/**',
        authorize: ({ user }) => user.isAdmin === true,
      },
      {
        route: '/api/_vitehub/console/**',
        authorize: ({ user }) => user.isAdmin === true,
      },
    ],
  },
})
```
::

::product-feature{label="Configure" title="Secrets come from Server Env at request time" to="/docs/auth/configure#runtime-options" link-label="Supply runtime options"}
`baseURL`, `secret`, and `secrets` are runtime-only. Return them from a Definition callback that reads typed Server Env and the request origin.

Declare the secrets in [Env](/docs/env) first. Never put the Auth secret in Public Env or client code.

#code
```ts [vite.config.ts]
import { hubAuth } from '@vite-hub/auth/vite'
import { env, hubEnv } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubEnv(), hubAuth()],
  env: {
    server: {
      auth: {
        secret: env({ secret: true, source: env.source('BETTER_AUTH_SECRET') }),
      },
    },
  },
})
```

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth(({ env, requestOrigin }) => ({
  appName: 'Acme',
  baseURL: requestOrigin,
  secret: env.auth.secret.unseal(),
}))
```
::

::product-feature{label="Storage" title="Placement metadata is not a database adapter" to="/docs/auth/configure#storage-placement-metadata" link-label="Record storage placement" reverse}
The default setup proves discovery and the session route. It is not durable storage. `database` and `secondaryStorage` record the intended Database and KV Store for inspection, and ViteHub removes them before it calls `betterAuth()`.

To persist sessions, return a concrete Better Auth adapter from the Definition callback or its `runtime` field.

#code
```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  database: { name: 'auth', dedicated: true },
  secondaryStorage: { store: 'auth' },
})
```
::

::product-feature{label="Agents" title="Map the signed-in user to an Agent Invoker" to="/docs/getting-started/concepts/auth-users-and-agent-invokers" link-label="Read about Auth Users and Agent Invokers"}
Agents receive Agent Invokers, not Auth sessions. `authenticated()` reads the same-app Better Auth session and maps the Auth User to an Invoker with `kind: "authUser"`.

When a required session does not exist, it throws `AUTHENTICATION_REQUIRED`, and HTTP adapters return `401`.

#code
```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { authenticated } from '@vite-hub/auth/agent'

export default defineAgent({
  invoker: authenticated(),
  driver: {
    run: ({ invoker }) => ({ invoker }),
  },
})
```
::

::product-feature{label="Hosts" title="Better Auth owns sign-in, ViteHub owns the route" to="/docs/auth/hosts" link-label="See what each host gets" reverse}
Sign-in methods, OAuth providers, plugins, and storage stay in Better Auth options. ViteHub generates the route handler, access middleware, and ambient types that the host needs.

Set `route: false` only when a host integration or a manual route mounts the handler. Use [Connections](/docs/connections) for OAuth grants to third-party accounts that your app calls.

#code
```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  route: false,
})
```
::
