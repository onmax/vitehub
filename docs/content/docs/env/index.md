---
title: Env
navigation.title: Overview
description: Declare public, build-time, server runtime, and secret values behind typed ViteHub accessors.
navigation.order: 1
icon: i-lucide-key-round
---

Use Env to declare browser-safe values, build replacements, server-only values, and secrets without mixing their access rules. ViteHub generates typed imports for browser and server code and redacts Secret Env values by default.

Your host still stores and supplies secrets. Server code calls `unseal()` only where it needs the raw value.

Use [Env Bridge](/docs/env/bridge) when administrators must replace a credential while the application runs. Use [Connections](/docs/connections) when the app calls a third-party API for a connected account.

```ts [server/github.ts]
import { useServerEnv } from '#vitehub/env/server'

export async function listIssues() {
  const { github } = useServerEnv()

  return fetch('https://api.github.com/issues', {
    headers: {
      authorization: `Bearer ${github.token.unseal()}`,
    },
  })
}
```

## Use Env with Agents

Read application secrets through Server Env inside Agent and Capability callbacks. Don't pass secrets through Agent Invocation metadata or model-facing instructions.

Built-in Agent Channels such as `telegram()` declare their credentials under `env.server.<channel>` when an Agent uses them. See [Channel Env](/docs/agents/channels#channel-env) for the names and how to rename one.

Env is usually not an agent-facing Capability. Other Capabilities consume Server Env when they need credentials, provider tokens, or app-owned configuration.

The [ask Driver](/docs/agents/agent-drivers#use-an-ask-driver) reads the `typesafe` group. Declare it with `typesafeEnv()`:

```ts [vite.config.ts]
import { typesafeEnv } from 'vite-hub/env'

export default defineConfig({
  env: {
    server: {
      typesafe: typesafeEnv({ provider: 'vercel' }),
    },
  },
})
```

| `provider` | `apiKey` source | `model` default |
| --- | --- | --- |
| `"typesafe"` (default) | Required Secret Env `TYPESAFE_API_KEY`. | `jev-latest` |
| `"vercel"` | Optional Secret Env `AI_GATEWAY_API_KEY`. Without it, the client uses `VERCEL_OIDC_TOKEN` on Vercel. | `typesafe-ai/jev` |

`TYPESAFE_DEFAULT_MODEL` overrides the model. The `model` option changes the default.
