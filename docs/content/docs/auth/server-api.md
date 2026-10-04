---
title: Auth server API
description: Read sessions, call Better Auth, and guard routes from server and Vue code.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `defineAuth` from `@vite-hub/auth` | Declare the Primary Auth Definition. |
| `hubAuth` from `@vite-hub/auth/vite` | Register Auth discovery, route exposure, and generated server aliases. |
| `auth`, `getAuth`, `getAuthForRequest` from `@vite-hub/auth/server` | Access the Better Auth instance from server code. |
| `handleAuth`, `handleAuthRequest`, `createAuthHandler` from `@vite-hub/auth/server` | Mount or call the Auth handler manually. |
| `requireAuth` from `@vite-hub/auth/server` | Guard server routes with an Auth Session. |
| `requireAuthAccessRoutes` from `@vite-hub/auth/server` | Guard selected configured access routes. |
| `authorizeRequest` from `@vite-hub/auth/server` | Authorize one resource request with `true` or an `authorize` callback. Never redirects to sign-in. |
| `useUserSession`, `useSession`, `createAuthClient` from `@vite-hub/auth/vue` | Read session state and call Better Auth from Vue. |
| `authenticated` from `@vite-hub/auth/agent` | Map a Better Auth session into an Agent Invoker. |
| `getViteHubErrorShape` from `@vite-hub/runtime` | Handle missing authentication and provider failures by stable Auth code. |

## Use it at runtime

The default Auth route is `/api/auth/**`. ViteHub mounts it automatically, so same-origin apps do not need a manual route file.

Vue apps can use the same-origin ViteHub Auth client and normalized session state directly. `useUserSession()` exposes `user`, `session`, sign-in and sign-out actions, and `loggedIn`, `pending`, and `ready` refs.

```ts [lib/auth-client.ts]
import { useUserSession } from '@vite-hub/auth/vue'

export const userSession = useUserSession()
```

Import `createAuthClient` from the same entry when you use a custom `basePath` or Better Auth client plugins. Pass the same `basePath` to the client and the Definition.

Server code can read the discovered Auth instance or require a session for a request.

```ts [server/api/me.get.ts]
import { auth } from '@vite-hub/auth/server'

export default defineEventHandler(async (event) => {
  const headers = new Headers(getRequestHeaders(event))

  return auth.api.getSession({ headers })
})
```

## Server helpers

| Helper | Description |
| --- | --- |
| `auth` | Proxy to the discovered Better Auth instance. |
| `getAuth(runtimeOptions?)` | Returns the discovered Better Auth instance. |
| `getAuthForRequest(request, runtimeOptions?, event?)` | Returns a request-aware Better Auth instance. |
| `handleAuth(input, runtimeOptions?)` | Handles an Auth HTTP request. |
| `handleAuthRequest(definition, request, runtimeOptions?, event?)` | Handles an Auth request for an explicit Auth Definition. |
| `createAuthHandler(definition, runtimeOptions?)` | Creates a Better Auth handler from a Definition. |
| `createAuthAccessHandler(routes, definition?)` | Creates a handler that matches discovered route metadata, then authenticates and runs every matching authorization rule. |
| `requireAuth(input, definition?)` | Returns `undefined` when a session exists. Otherwise returns an unauthorized or sign-in response. |
| `authorizeRequest(input, authorize, definition?)` | Returns `undefined` when allowed, JSON `401` without a session, `403` when `authorize` returns `false`, or the callback's `Response`. |

### Authorize access routes

Add `authorize` when a session alone is not enough. ViteHub calls it only after authentication.

| `authorize` returns | Result |
| --- | --- |
| `true` | The request continues. |
| `false` | `403`. |
| A `Response` | That response, as-is. |

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

The callback receives the authenticated `user`, `session`, and request. ViteHub does not define an admin role. Map your own role or permission model here.

The same callback signature protects [Blob serve routes](/docs/blob/configure#protect-served-objects) and [Collections](/docs/source/server-api#protect-a-collection). Their generated routes call `authorizeRequest(input, authorize)`. Unlike `requireAuth()`, it does not start a sign-in redirect, so image and fetch requests receive a status code.

Generated access middleware calls `createAuthAccessHandler(routes, definition?)`. Manual hosts can use it with a Web `Request` or `{ req: Request }`. Pass `{ route, method?, authorize?: true }` metadata in the same order as the Definition's `access.routes`. A route ending in `/**` matches its base path and descendants. Exact routes match only that path. All matching rules apply, and `authorize: true` requires the corresponding runtime callback. Unmatched requests do not load the Auth Definition or session.

`requireAuthAccessRoutes(input, routeIndexes, definition, requiredAuthorizeRouteIndexes, { redirectToSignIn: false })` returns `401` for an unauthenticated browser request instead of starting the configured provider sign-in redirect. Use it when the host shows its own sign-in page and starts provider sign-in after an explicit action. By default, it keeps the `access.signIn` redirect.

Read [Console](/docs/development/console#protect-the-console-route) for its page, RPC endpoint, provider status route, and disabled behavior. The Console can also use its own Console Auth instead of these access routes. On Cloudflare Workers, the [Cloudflare Access provider](/docs/development/console#protect-the-console-route) protects the Console without a Better Auth database.
