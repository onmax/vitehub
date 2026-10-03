---
title: Blob
navigation.title: Overview
description: Store uploads, generated files, binary objects, and metadata with one object-storage API.
navigation.order: 1
icon: i-lucide-files
---

::product-hero{tagline="One object-storage API for uploads, generated media, exports, and their metadata. Your route keeps the same import on the local file system, Cloudflare R2, Vercel Blob, S3, and the other drivers."}

```ts [server/api/files.post.ts]
import { blob } from '@vite-hub/blob'

export default defineEventHandler(async () => {
  const [error, object] = await blob.put('hello.txt', 'Hello from ViteHub')
  if (error) throw error
  return object
})
```

::

::product-feature{label="Server API" title="Every method returns an error and a value" to="/docs/blob/server-api" link-label="Read the Blob server API"}
`put`, `get`, `head`, `list`, `del`, and `sign` return `[error, value]`. A provider or storage failure is a `ViteHubError` with a `BLOB_*` code. Invalid arguments and unknown stores still throw.

`blob.sign()` gives a client short-lived `GET` or `PUT` access to one private object.

#code
```ts [server/api/files/[...path].get.ts]
import { blob } from '@vite-hub/blob'

export default defineEventHandler(async (event) => {
  const path = getRouterParam(event, 'path')!
  const [error, object] = await blob.get(path)
  if (error) throw error

  if (!object) {
    throw createError({ statusCode: 404 })
  }

  return object
})
```
::

::product-feature{label="Uploads" title="Validate and store a form upload in one call" to="/docs/blob/server-api" link-label="Handle uploads" reverse}
`blob.handleUpload()` reads a `multipart/form-data` request, checks each file with `ensureBlob()`, and stores it. A file that fails the size or type check stops the request before anything is stored.

Multipart uploads split large files into parts on the `fs`, `cloudflare-r2`, and `vercel-blob` drivers.

#code
```ts [server/api/files.post.ts]
import { blob } from '@vite-hub/blob'

export default defineEventHandler(async (event) => {
  // Authorize the request here. The route decides who may upload.
  const [error, objects] = await blob.handleUpload(event, {
    formKey: 'files',
    ensure: { maxSize: '8MB', types: ['image'] },
    put: { prefix: 'avatars', addRandomSuffix: true },
  })
  if (error) throw error
  return objects
})
```
::

::product-feature{label="Configure" title="Pick a driver for each store, keep the import" to="/docs/blob/configure" link-label="Configure Blob Stores and drivers"}
Without a driver, ViteHub infers Cloudflare R2, Netlify Blobs, Vercel Blob, or the local file system from the host. Set `driver` to pick S3, Google Cloud Storage, Azure, Supabase, or another provider.

Named stores keep objects apart. An opt-in serve route can stream objects and require an Auth session.

#code
```ts [vite.config.ts]
import { hubBlob } from '@vite-hub/blob/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubBlob()],
  blob: {
    stores: {
      default: { driver: 'fs' },
      reports: { driver: 'vercel-blob', access: 'private' },
    },
  },
})
```
::

::product-feature{label="Agent capability" title="An Agent can publish the files it creates" to="/docs/blob/agent-capability" link-label="Give an Agent Blob tools" reverse}
Attach the Blob Capability to hand an Agent a `blob_read` tool, and in write mode a `blob_edit` tool. `policy` gates the writes.

With `assetPaths`, a Provider-backed Agent writes files under a declared directory. ViteHub publishes the files that its final answer links and rewrites the links to public URLs.

#code
```ts [server/agents/review.ts]
import { defineAgent } from 'vite-hub/agent'
import { blob } from 'vite-hub/agent/capabilities'
import { github } from 'vite-hub/agent/channels'

export default defineAgent({
  capabilities: [
    blob({ assetPaths: ['artifacts'], mode: 'write', policy: 'deny' }),
  ],
  channels: {
    github: github({ pullRequest: true }),
  },
  driver: 'codex',
  workspace: { commit: true, mode: 'write' },
})
```
::

::product-feature{label="Hosts" title="Read and write the running app's store from a terminal" to="/docs/blob/hosts" link-label="See host and provider notes"}
The development CLI calls the same Blob storage as the running app. Pass `--store <name>` for a named store. The build emits the binding or bucket config that the selected host needs.

Use [Workspace](/docs/workspace) when files need paths, snapshots, or diffs. Keep catalogs and richer queries in [KV](/docs/kv) or [Database](/docs/database).

#code
```bash [Terminal]
pnpm vitehub blob list --prefix avatars/
pnpm vitehub blob head avatars/ada.png --json
pnpm vitehub blob put avatars/ada.png ./ada.png
pnpm vitehub blob get avatars/ada.png --output ./copy.png
pnpm vitehub blob del avatars/ada.png
```
::
