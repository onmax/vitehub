---
title: Workspace hosts
description: Generated Workspace output, types, and Cloudflare Artifacts Store behavior on deployed hosts.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

This page covers generated Workspace output and the Cloudflare Artifacts Store. [Store providers](/docs/workspace/configure#store-providers) lists the default Store for each host.

## Provider output

The Workspace package discovers definitions, generates Workspace name types, prepares build-time assets, and connects Workspace Stores. A Workspace Store can use Blob, but application code still uses Workspace for file operations.

::note
The Nuxt Workspace handoff is only for hosted Workspace runtime setup and generated registry transport. It does not create Nitro-specific Workspace discovery, public provider store constructors, or a second Workspace authoring model.
::

Add generated types when you want `useWorkspace()` to narrow discovered Workspace names.

```json [tsconfig.json]
{
  "include": [
    "server/**/*.ts",
    "src/**/*.ts",
    ".vitehub/types/**/*.d.ts"
  ]
}
```

## Cloudflare Artifacts

Select Cloudflare Artifacts when a deployed Worker needs durable Workspace state:

```ts [vite.config.ts]
import { hubWorkspace } from '@vite-hub/workspace/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubWorkspace()],
  workspace: {
    store: {
      provider: 'cloudflare-artifacts',
      binding: 'WORKSPACE_ARTIFACTS',
      namespace: 'vitehub',
    },
  },
})
```

The Vite integration adds Artifacts Stores to generated Cloudflare config for the module and discovered definitions. It preserves application bindings and removes only bindings that Workspace generated when the provider changes. Reusing one binding name for different namespaces fails the build. Each named Workspace uses `<repoPrefix><encoded-workspace-name>` unless `repo` selects one repository, so names with repository-unsafe characters remain isolated.

`workspace.snapshot()` commits and pushes the current file tree. Its snapshot id is the pushed Git commit SHA. File metadata is stored in the repository with the Workspace tree so Source-backed write protection and media types survive a fresh Worker instance.

Cloudflare Artifacts is currently a closed beta and is not available on Workers Free, so the Cloudflare default remains the ephemeral `memory` Store. The Worker adapter clones into isolate memory; use it for deliberately small Workspaces rather than assuming the Artifacts repository limit is also a usable Worker checkout size. For large repositories in a sandbox, container, or VM, use Cloudflare's [ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/) directly.

Artifacts repositories are private Git storage. Use [Blob](/docs/blob) with R2 or another provider when an Agent needs a public delivery URL.
