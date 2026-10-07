---
title: Run an image optimizer in a Sandbox
description: Create a package project, run it outside the app process, and read its native Response.
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Sandbox runs a named package project outside your app process. The project can carry its own dependencies and the Vite configuration chooses Cloudflare or Vercel Sandbox. Your route only sees a native `Response`.

## Install and choose a provider

This tutorial uses Vercel Sandbox:

```bash [Terminal]
pnpm add @vite-hub/sandbox @vercel/sandbox h3
pnpm add -D @vite-hub/cli vite
```

```ts [vite.config.ts]
import { hubSandbox } from '@vite-hub/sandbox/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubSandbox({ provider: 'vercel' })],
})
```

For Cloudflare, install `@cloudflare/sandbox` and change `provider` to `cloudflare`. The package project and route stay the same.

## Create the package project

Create the package manifest and entrypoint under `server/sandboxes/image-optimizer`:

```json [server/sandboxes/image-optimizer/package.json]
{
  "private": true,
  "type": "module",
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

The folder name is the Definition name. The entrypoint is ordinary ESM code and does not import the Sandbox package.

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

You should see:

```json [Response]
{ "pixels": 786432, "format": "webp" }
```

Check `response.ok` before reading the body. A timeout is a non-2xx response with a `SANDBOX_TIMEOUT` error. The provider decides the execution boundary and its available network, filesystem, and process access.

## Inspect and continue

```bash [Terminal]
pnpm vite build
pnpm vitehub inspect definitions --kind sandbox
```

- Read [Configure](/docs/sandbox/configure) for package projects and free-form Definitions.
- Read [Set timeouts and handle failures](/docs/sandbox/limits-and-errors) for response errors and cleanup.
- Read [Hosts](/docs/sandbox/hosts) before switching providers.
