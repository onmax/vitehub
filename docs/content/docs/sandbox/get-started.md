---
title: Run an image optimizer in a Sandbox
description: Create a package project, run it outside the app process, and read its native Response.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Sandbox runs a named package project outside your app process. The project can
carry its own dependencies and the Vite configuration chooses Cloudflare or
Vercel Sandbox. Your route only sees a native `Response`. The nested manifest
and entrypoint below are a separate package project, not another server route.

::tutorial-step{title="Install and choose a provider"}
## Install and choose a provider

Use Node.js 24.15 or newer and an existing Vite application. This tutorial uses a Vercel project with Sandbox access. Before starting the server, export `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID` in its terminal, or use the project's Vercel environment. Execution uses remote, potentially billed infrastructure.

```bash [commands/install]
pnpm add @vite-hub/sandbox @vercel/sandbox nitro h3
pnpm add -D @vite-hub/cli vite
```

```ts [vite.config.ts]
import { hubSandbox } from '@vite-hub/sandbox/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [hubSandbox({ provider: 'vercel' }), nitro() as never],
})
```

For Cloudflare, install `@cloudflare/sandbox` and use the [Cloudflare host integration](/docs/frameworks-hosts/cloudflare) to generate the required Container, Durable Object binding, migration, and Worker exports. Changing the provider alone does not supply these resources.

::

::tutorial-step{title="Create the package project"}
## Create the package project

Create the package manifest and entrypoint under
`server/sandboxes/image-optimizer`. The folder name becomes the Sandbox
Definition name, while the manifest describes the package that runs in the
isolated environment.

```json [server/sandboxes/image-optimizer/package.json]
{
  "name": "image-optimizer",
  "private": true,
  "type": "module",
  "exports": "./index.ts",
  "vitehub": {
    "sandbox": { "timeout": 30000 }
  }
}
```

```ts [server/sandboxes/image-optimizer/index.ts]
type ImageInput = { width: number, height: number }

export default async function optimize({ width, height }: ImageInput) {
  return {
    pixels: width * height,
    format: 'webp',
  }
}
```

The entrypoint is ordinary ESM code and does not import the Sandbox package.
If the package needs a native dependency, add it to this nested `package.json`;
it is installed and bundled inside the Sandbox project.

::

::tutorial-step{title="Call it from a route"}
## Call it from a route

```ts [server/api/image-optimizer.post.ts]
import { createError, defineEventHandler, readBody } from 'h3'
import { runSandbox } from '@vite-hub/sandbox'

export default defineEventHandler(async (event) => {
  const input = await readBody<{ width: number, height: number }>(event)
  const response = await runSandbox('image-optimizer', input)

  if (!response.ok)
    throw createError({ statusCode: response.status, data: await response.json() })

  return await response.json()
})
```

Start the Nitro development server with the credentials available in this terminal:

```bash [commands/dev]
pnpm vite dev
```

Keep it running. In another terminal, send the input to the route:

```bash [commands/request]
curl -X POST http://localhost:5173/api/image-optimizer \
  -H 'content-type: application/json' \
  -d '{"width":1024,"height":768}'
```

With Vercel Sandbox access configured, you should see:

```json [output/image-optimizer.json]
{ "pixels": 786432, "format": "webp" }
```

This JSON is the response body, not a file that the Sandbox writes. Check
`response.ok` before reading the body. A timeout is a non-2xx response with a
`SANDBOX_TIMEOUT` error. The provider decides the execution boundary and its
available network, filesystem, and process access.

::

::tutorial-step{title="Inspect and continue"}
## Inspect and continue

```bash [commands/inspect]
pnpm vite build
pnpm vitehub inspect definitions --kind sandbox
```

Start the generated Nitro server with Vercel Sandbox credentials in the environment:

```bash [commands/server]
VERCEL_TOKEN=... VERCEL_TEAM_ID=... VERCEL_PROJECT_ID=... node .output/server/index.mjs
```

Call the route from another terminal:

```bash [commands/request-built]
curl -X POST http://localhost:3000/api/image-optimizer \
  -H 'content-type: application/json' \
  -d '{"width":1024,"height":768}'
```

- Read [Configure](/docs/sandbox/configure) for package projects and free-form Definitions.
- Read [Set timeouts and handle failures](/docs/sandbox/limits-and-errors) for response errors and cleanup.
- Read [Hosts](/docs/sandbox/hosts) before switching providers.
::
