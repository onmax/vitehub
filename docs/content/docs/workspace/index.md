---
title: Workspace
navigation.title: Overview
description: Build persistent file-tree state with rules, Source Bindings, snapshots, diffs, and sessions.
navigation.order: 1
icon: i-lucide-folder-git-2
---

::product-hero{tagline="A persistent file tree for server code and Agents, with the same calls on every Store provider."}
  :::code-group
  ```ts [Route]
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

  ```ts [Definition]
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

  ```ts [Agent]
  import { defineAgent } from 'vite-hub/agent'
  import { workspaceShell } from 'vite-hub/agent/capabilities'

  export default defineAgent({
    driver: { model: 'openai/gpt-5.1-mini' },
    workspace: { mode: 'write' },
    capabilities: [workspaceShell({ mode: 'write' })],
  })
  ```

  ```bash [CLI]
  pnpm vitehub workspace dev --url http://localhost:5173 docs exec pnpm test --filter api
  ```
  :::
::

::product-features
  :::product-feature-item{title="One file declares Sources and rules" icon="i-lucide-folder-tree" to="/docs/workspace/configure" link-label="Configure Workspace"}
  A Definition in `server/workspaces` binds read-only Sources and sets write access, media type, and size rules by path pattern.
  :::

  :::product-feature-item{title="Sync a Source and snapshot the result" icon="i-lucide-code-2" to="/docs/workspace/server-api" link-label="Workspace server API"}
  `workspace.sync()` covers Sources declared with `sync`, returns per-Source counts, and can snapshot the result.
  :::

  :::product-feature-item{title="Run a command and keep its diff" icon="i-lucide-terminal" to="/docs/workspace/server-api#use-sessions-and-shell" link-label="Workspace Sessions"}
  A Workspace Session materializes the tree into a Box Session and handles the diff, commit, and rollback on close.
  :::

  :::product-feature-item{title="Pick the Store once, keep the calls" icon="i-lucide-sliders-horizontal" to="/docs/workspace/configure#store-providers" link-label="Workspace Store providers"}
  A Local Store in development; Memory, Cloudflare Artifacts, Vercel Blob, GitHub, or a custom Store behind the same `useWorkspace()` calls.
  :::

  :::product-feature-item{title="The same tree, as tools for an Agent" icon="i-lucide-bot" to="/docs/workspace/agent-capability" link-label="Workspace Agent capability"}
  `workspaceShell()` adds a `shell` tool in read mode and file mutation tools in write mode, still bound by Workspace rules.
  :::

  :::product-feature-item{title="Not for plain objects or read-only retrieval" icon="i-lucide-git-branch" to="/docs/blob" link-label="Compare Blob"}
  Use Blob for objects without file-tree behavior and Source for read-only retrieval.
  :::
::
