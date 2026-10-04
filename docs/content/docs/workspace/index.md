---
title: Workspace
navigation.title: Overview
description: Build persistent file-tree state with rules, Source Bindings, snapshots, diffs, and sessions.
navigation.order: 1
icon: i-lucide-folder-git-2
---

::product-hero{tagline="A persistent file tree for server code and Agents, with rules, Source Bindings, snapshots, and sessions. Your route makes the same calls on every Store provider."}

```ts [server/api/drafts.post.ts]
import { useWorkspace } from '@vite-hub/workspace'

export default defineEventHandler(async (event) => {
  const workspace = useWorkspace('docs', { mode: 'write' })
  const body = await readBody<{ text: string }>(event)

  await workspace.fs.writeFile('drafts/summary.md', body.text, {
    mediaType: 'text/markdown',
  })

  return workspace.diff()
})
```

::

::product-feature{label="Definitions" title="One file declares the tree, its Sources, and its rules" to="/docs/workspace/configure" link-label="Configure Workspace Definitions"}
A Workspace Definition is one file in `server/workspaces`. Its file path gives the name. `sources` binds read-only content into the tree from local globs, GitHub, MCP resources, HTTP, or a custom loader.

`rules` set write access, media type, size, and validation by path pattern. A Source-Backed Path stays read-only.

#code
```ts [server/workspaces/docs.ts]
import { defineWorkspace, glob, github } from '@vite-hub/workspace'

export default defineWorkspace({
  sources: {
    docs: glob({
      cwd: '.',
      include: ['README.md', 'docs/**/*.md'],
    }),
    handbook: github({
      repo: 'acme/handbook',
      ref: 'main',
      root: 'support',
      mount: 'handbook',
      materialize: 'lazy',
      sync: true,
    }),
  },
  rules: {
    '/**': { write: false },
    '/drafts/**': { write: true, mediaType: 'text/markdown' },
  },
})
```
::

::product-feature{label="Server API" title="Sync a Source and snapshot the result in one call" to="/docs/workspace/server-api" link-label="Read the Workspace server API" reverse}
`useWorkspace(name)` returns read access. Request `{ mode: 'write' }` only at the call site that changes files. The writable facade adds `diff()`, `snapshot()`, `sync()`, and sessions.

Only Sources declared with `sync` take part in `workspace.sync()`. It returns per-Source counts and can snapshot the result.

#code
```ts [server/tasks/sync-docs.ts]
import { useWorkspace } from '@vite-hub/workspace'

export async function syncDocs() {
  const workspace = useWorkspace('docs', { mode: 'write' })

  return workspace.sync({
    sources: ['handbook'],
    snapshot: { message: 'Sync handbook source' },
  })
}
```
::

::product-feature{label="Sessions" title="Run a command in a session and keep its diff" to="/docs/workspace/server-api#use-sessions-and-shell" link-label="Use Workspace Sessions"}
A Workspace Session materializes the file tree into an open Box Session. Box runs the command. Workspace handles the diff, the commit, and the rollback on close.

During development, `vitehub workspace dev` runs the same flow from the terminal and commits successful changes.

#code
```ts [server/tasks/test-docs.ts]
import { resolveBox } from '@vite-hub/box'
import { useWorkspace } from '@vite-hub/workspace'

export async function testDocs() {
  const box = await resolveBox({ runtime: 'trusted-host' }, undefined)
  const host = await box.open()
  const session = await useWorkspace('docs', { mode: 'write' }).startSession({ host })

  try {
    await session.exec('pnpm', ['test'])
    return await session.diff()
  }
  finally {
    await session.close()
    await host.close()
  }
}
```

```bash [Terminal]
pnpm vitehub workspace dev --url http://localhost:5173 docs exec pnpm test --filter api
```
::

::product-feature{label="Store providers" title="Pick the Store once, keep the calls" to="/docs/workspace/configure#store-providers" link-label="Compare Store providers" reverse}
Development uses a Local Store. Memory, Cloudflare Artifacts, Vercel Blob, GitHub, and custom Stores take the same `useWorkspace()` calls.

Without a `store`, ViteHub selects one from the host and environment. Select Cloudflare Artifacts or GitHub yourself.

#code
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
::

::product-feature{label="Agent capability" title="The same tree, as tools for an Agent" to="/docs/workspace/agent-capability" link-label="Give an Agent Workspace tools"}
Installing Workspace gives no model access to it. `workspaceShell()` adds a `shell` tool for inspection in read mode, and file mutation tools in write mode. Workspace rules still decide which files the Agent can change.

Provider Drivers can also run allowlisted executables through `workspace_exec`.

#code
```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { workspaceShell } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  workspace: { mode: 'write' },
  capabilities: [workspaceShell({ mode: 'write' })],
})
```
::

::product-feature{label="Hosts" title="Generated types narrow every Workspace name" to="/docs/workspace/hosts" link-label="See host and provider notes" reverse}
The Vite integration discovers Definitions, generates Workspace name types, prepares build-time assets, and connects Stores. Add the generated types so `useWorkspace()` narrows to discovered names.

Use [Blob](/docs/blob) for objects without file-tree behavior and [Source](/docs/source) for read-only retrieval.

#code
```json [tsconfig.json]
{
  "include": [
    "server/**/*.ts",
    "src/**/*.ts",
    ".vitehub/types/**/*.d.ts"
  ]
}
```
::
