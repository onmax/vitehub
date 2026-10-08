---
title: Define your first Agent
description: Install ViteHub, define an offline Agent, call it from a route, and inspect the result.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
navigation.group: Start
icon: i-lucide-rocket
---

An Agent Definition describes one server-side operation. Start with a local
function Driver so you can verify discovery and invocation before adding a
model, a Channel, or Capabilities.

::note
You need Node.js 24.15 or newer, `pnpm`, and an existing Vite server app. This
example runs offline and needs no provider key.
::

::tutorial-step{title="Install and configure"}
## Install and configure

```bash [commands/install]
pnpm add vite-hub nitro h3
pnpm add -D vite
```

Register the Agent integration in `vite.config.ts`:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', agent: true }), nitro() as never],
})
```

::

::tutorial-step{title="Define the Agent"}
## Define the Agent

Create `server/agents/greeting.ts`. The file name becomes the Agent name.

```ts [server/agents/greeting.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: {
    run({ prompt }) {
      const name = typeof prompt === 'string' ? prompt : 'friend'
      return { text: `Hello, ${name}!` }
    },
  },
})
```

The function Driver owns the whole run. Replace it with a model Driver when the
application needs generation or tools.
::

::tutorial-step{title="Call and verify the Agent"}
## Call and verify the Agent

Expose the Agent from an H3 route:

```ts [server/api/greeting.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { runAgent } from 'vite-hub/agent'
import greeting from '../agents/greeting'

export default defineEventHandler(async (event) => {
  const { prompt } = await readBody<{ prompt: string }>(event)
  const [error, result] = await runAgent(greeting, { prompt })
  if (error) throw error
  return result
})
```

Start Vite and send one request:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. In another terminal, run:

```bash [commands/request]
curl -X POST http://localhost:5173/api/greeting \
  -H 'content-type: application/json' \
  -d '{"prompt":"Ada"}'
```

The response is `{ "text": "Hello, Ada!" }`. Build and inspect the discovered
Agent before deploying:

```bash [commands/inspect]
pnpm vite build
pnpm vitehub inspect definitions --kind agent
```

Continue with [Agent Drivers](/docs/agents/agent-drivers), [Capabilities](/docs/agents/capabilities), and [Workspace context](/docs/agents/workspace-context).
::
