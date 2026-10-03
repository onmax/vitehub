---
title: Blob
navigation.title: Overview
description: Store uploads, generated files, binary objects, and metadata with one object-storage API.
navigation.order: 1
icon: i-lucide-files
---

::product-hero{tagline="One object-storage import for uploads and generated files on the local file system, Cloudflare R2, Vercel Blob, and S3."}
  :::code-group
  ```ts [Route]
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

  ```ts [Agent]
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

  ```bash [CLI]
  pnpm vitehub blob list --prefix avatars/
  pnpm vitehub blob head avatars/ada.png --json
  pnpm vitehub blob put avatars/ada.png ./ada.png
  pnpm vitehub blob get avatars/ada.png --output ./copy.png
  pnpm vitehub blob del avatars/ada.png
  ```
  :::
::

::product-features
  :::product-feature-item{title="Every method returns an error and a value" icon="i-lucide-code-2" to="/docs/blob/server-api" link-label="Blob server API"}
  `put`, `get`, `head`, `list`, `del`, and `sign` return `[error, value]`, with a `BLOB_*` code on provider failures.
  :::

  :::product-feature-item{title="Validate and store uploads in one call" icon="i-lucide-shield-check" to="/docs/blob/server-api#upload-files" link-label="Upload files"}
  `blob.handleUpload()` checks each form file for size and type, and a failed check stops the request before anything is stored.
  :::

  :::product-feature-item{title="Pick a driver per store, keep the import" icon="i-lucide-sliders-horizontal" to="/docs/blob/configure" link-label="Configure Blob"}
  Without a `driver`, ViteHub infers R2, Netlify Blobs, Vercel Blob, or the file system from the host; set one for S3 or Azure.
  :::

  :::product-feature-item{title="An Agent can publish the files it creates" icon="i-lucide-bot" to="/docs/blob/agent-capability" link-label="Blob Agent capability"}
  With `assetPaths`, ViteHub publishes the files that an Agent's final answer links and rewrites those links to public URLs.
  :::

  :::product-feature-item{title="Manage the running app's objects from a terminal" icon="i-lucide-terminal" to="/docs/blob/hosts" link-label="Blob hosts and CLI"}
  The development CLI calls the same storage as the app, and the build emits the binding or bucket config the host needs.
  :::

  :::product-feature-item{title="Not for file trees or rich queries" icon="i-lucide-git-branch" to="/docs/workspace" link-label="Compare Workspace"}
  Use Workspace when files need paths, snapshots, or diffs, and KV or Database for catalogs and richer queries.
  :::
::
