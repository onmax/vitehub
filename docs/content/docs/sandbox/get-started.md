---
title: Run an image optimizer in a Sandbox
description: Create a package project, run it outside the app process, and read its native Response.
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Sandbox runs a named package project outside your app process. The project can carry its own dependencies and the Vite configuration chooses Cloudflare or Vercel Sandbox. Your server code only sees a native `Response`.

## Install and choose a provider

Use Node.js 24 or newer and a Vercel project with Sandbox access. At runtime, use the project environment or set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`. Execution uses remote, potentially billed infrastructure.

Start in an empty directory:

```bash [Terminal]
pnpm init
pnpm pkg set type=module
pnpm add @vite-hub/sandbox @vercel/sandbox
pnpm add -D @vite-hub/cli vite
```

```ts [vite.config.ts]
import { hubSandbox } from '@vite-hub/sandbox/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  appType: 'custom',
  plugins: [hubSandbox({ provider: 'vercel' })],
  build: { ssr: 'src/server.ts' },
})
```

Cloudflare also needs host integration to generate Containers, a Durable Object binding, migrations, and Worker exports. Follow [Hosts](/docs/sandbox/hosts) for that setup; changing the provider alone is not sufficient.

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

## Run the server entry

Create an explicit server entry that invokes the discovered Sandbox once:

```ts [src/server.ts]
import { runSandbox } from '@vite-hub/sandbox'

const response = await runSandbox('image-optimizer', { width: 1024, height: 768 })
if (!response.ok)
  throw new Error(await response.text())

console.log(JSON.stringify(await response.json()))
```

Build through Vite to generate discovery and runtime aliases, then execute the entry with the Vercel credentials in your environment:

```bash [Terminal]
pnpm vite build
node dist/server.js
```

The process prints:

```json [Output]
{ "pixels": 786432, "format": "webp" }
```

This example computes image metadata; it does not encode an image file.

Check `response.ok` before reading the body. A timeout is a non-2xx response with a `SANDBOX_TIMEOUT` error. The provider decides the execution boundary and its available network, filesystem, and process access.

## Inspect and continue

```bash [Terminal]
pnpm vitehub inspect definitions --kind sandbox
```

- Read [Configure](/docs/sandbox/configure) for package projects and free-form Definitions.
- Read [Set timeouts and handle failures](/docs/sandbox/limits-and-errors) for response errors and cleanup.
- Read [Hosts](/docs/sandbox/hosts) before switching providers.
