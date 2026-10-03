---
title: Auth
navigation.title: Overview
description: Configure Better Auth server behavior, route exposure, runtime options, and session checks.
navigation.order: 1
icon: i-lucide-shield-check
---

Auth adds Better Auth sessions and server-side identity checks to a ViteHub app. ViteHub discovers one Auth Definition, mounts its route, guards the routes you list, and provides server helpers. Better Auth still provides the sign-in UI, client plugins, storage adapters, and provider-specific behavior.

Use Auth when your application has users who sign in. Server Primitives and Agents work without it.

::tip
- **Auth** identifies the users of your application and their sessions. It answers "who sent this request?"
- **[Connections](/docs/connections)** hold OAuth grants for third-party accounts that your app calls, for example a Gmail account. They answer "which account does the app act for?"
- **[Env](/docs/env)** supplies the Auth secret and OAuth client credentials.
::

## Example

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  emailAndPassword: { enabled: true },
})
```

ViteHub mounts Better Auth at `/api/auth/**`. Read sessions in server code with `auth.api.getSession()` from `@vite-hub/auth/server`.

## Connect Auth to Agents

Auth identifies application users and sessions. Agents receive Agent Invokers. Map trusted Auth state into an Agent Invoker with `authenticated()` instead of adding Auth to the Agent Definition.

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

By default, `authenticated()` reads the same-app Better Auth session and maps the Auth User to an Agent Invoker with `kind: "authUser"`. Use the [Access](/docs/agents/capabilities/access) Capability for decisions based on invoker identity. Read [Auth Users and Agent Invokers](/docs/getting-started/concepts/auth-users-and-agent-invokers) for the mental model.

When a required Auth Session does not exist, `authenticated()` throws. Read [Handle required authentication](/docs/auth/limits-and-errors#handle-required-authentication) for the error codes.
