---
title: Auth
navigation.title: Overview
description: Configure Better Auth server behavior, route exposure, runtime options, and session checks.
navigation.order: 1
icon: i-lucide-shield-check
---

::product-hero{tagline="Better Auth sessions and route guards from one Auth Definition that ViteHub discovers and mounts for your host."}
  :::code-group
  ```ts [Definition]
  import { defineAuth } from '@vite-hub/auth'

  export default defineAuth({
    appName: 'Acme',
    emailAndPassword: { enabled: true },
  })
  ```

  ```ts [Route]
  import { auth } from '@vite-hub/auth/server'

  export default defineEventHandler(async (event) => {
    const headers = new Headers(getRequestHeaders(event))

    return auth.api.getSession({ headers })
  })
  ```

  ```ts [Access]
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

  ```ts [Agent]
  import { defineAgent } from '@vite-hub/agent'
  import { authenticated } from '@vite-hub/auth/agent'

  export default defineAgent({
    invoker: authenticated(),
    driver: {
      run: ({ invoker }) => ({ invoker }),
    },
  })
  ```
  :::
::

::product-features
  :::product-feature-item{title="Read the session in any server route" icon="i-lucide-user-check" to="/docs/auth/server-api" link-label="Auth server API"}
  ViteHub mounts Better Auth at `/api/auth/**`, and server code reads it through `auth` or guards a route with `requireAuth()`.
  :::

  :::product-feature-item{title="Guard listed routes, decide roles in code" icon="i-lucide-shield-check" to="/docs/auth/server-api#authorize-access-routes" link-label="Authorize access routes"}
  Middleware guards each `access.routes` entry, and `authorize` returns `true`, `false` for `403`, or a `Response`.
  :::

  :::product-feature-item{title="Secrets come from Server Env at request time" icon="i-lucide-key-round" to="/docs/auth/configure#runtime-options" link-label="Auth runtime options"}
  Return `baseURL`, `secret`, and `secrets` from a Definition callback that reads typed Server Env, never Public Env.
  :::

  :::product-feature-item{title="Placement metadata is not a database adapter" icon="i-lucide-database" to="/docs/auth/configure#storage-placement-metadata" link-label="Auth storage placement"}
  `database` and `secondaryStorage` only record intended storage, so return a concrete Better Auth adapter to persist sessions.
  :::

  :::product-feature-item{title="Map the signed-in user to an Agent Invoker" icon="i-lucide-bot" to="/docs/getting-started/concepts/auth-users-and-agent-invokers" link-label="Auth Users and Agent Invokers"}
  `authenticated()` maps the Better Auth session to an Invoker with `kind: "authUser"`, or throws `AUTHENTICATION_REQUIRED` when none exists.
  :::

  :::product-feature-item{title="Not for third-party account grants" icon="i-lucide-plug" to="/docs/connections" link-label="Compare Connections"}
  Better Auth owns sign-in to your app, so use Connections for OAuth grants to third-party accounts that your app calls.
  :::
::
