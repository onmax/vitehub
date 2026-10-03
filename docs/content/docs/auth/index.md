---
title: Auth
navigation.title: Overview
description: Configure Better Auth server behavior, route exposure, runtime options, and session checks.
navigation.order: 1
icon: i-lucide-shield-check
---

::product-hero{tagline="Better Auth sessions and route guards from one Auth Definition that ViteHub discovers and mounts for your host." providers="Better Auth"}
  :::code-group
  ```ts [Definition]
  import { defineAuth } from '@vite-hub/auth'

  export default defineAuth(({ env, requestOrigin }) => ({
    appName: 'Acme',
    baseURL: requestOrigin,
    secret: env.auth.secret.unseal(),
    socialProviders: {
      github: {
        clientId: env.auth.github.clientId,
        clientSecret: env.auth.github.clientSecret.unseal(),
      },
    },
  }))
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

::product-flow{caption="A listed route reaches its handler only after a session exists and authorize allows it."}
  :::product-flow-step{label="Better Auth route" detail="/api/auth/**"}
  :::
  :::product-flow-step{label="Session" detail="getSession({ headers })"}
  :::
  :::product-flow-step{label="Access rule" detail="access.routes"}
  :::
  :::product-flow-step{label="Authorize" detail="authorize({ user })"}
  :::
  :::product-flow-step{label="Result" detail="handler · 401 · 403"}
  :::
::

::product-features
  :::product-feature-item{title="Read the session in any server route" icon="i-lucide-user-check" to="/docs/auth/server-api"}
  Better Auth at `/api/auth/**`; guard routes with `requireAuth()`.
  :::

  :::product-feature-item{title="Guard listed routes, decide roles in code" icon="i-lucide-shield-check" to="/docs/auth/server-api#authorize-access-routes"}
  `authorize` returns `true`, `false` for `403`, or a `Response`.
  :::

  :::product-feature-item{title="Secrets come from Server Env at request time" icon="i-lucide-key-round" to="/docs/auth/configure#runtime-options"}
  Read `secret` and `baseURL` from Server Env, never Public Env.
  :::

  :::product-feature-item{title="Placement metadata is not a database adapter" icon="i-lucide-database" to="/docs/auth/configure#storage-placement-metadata"}
  Return a concrete Better Auth adapter to persist sessions.
  :::

  :::product-feature-item{title="Map the signed-in user to an Agent Invoker" icon="i-lucide-bot" to="/docs/getting-started/concepts/auth-users-and-agent-invokers"}
  `authenticated()` maps the session to an `authUser` Invoker.
  :::

  :::product-feature-item{title="Not for third-party account grants" icon="i-lucide-plug" to="/docs/connections"}
  Use Connections for OAuth grants to third-party accounts.
  :::
::
