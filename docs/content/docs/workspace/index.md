---
title: Workspace
navigation.title: Overview
description: Build persistent file-tree state with rules, Source Bindings, snapshots, diffs, and sessions.
navigation.order: 1
icon: i-lucide-folder-git-2
---

Use Workspace when server code or an Agent needs a persistent file tree. A Workspace can read and write files, sync Sources, create snapshots and diffs, and open transactional sessions. You control which operations each caller receives.

[Blob](/docs/blob) stores objects without file-tree behavior. [Source](/docs/source) retrieves read-only content. Workspace can store its files in Blob and bind content from Sources.

## Define a workspace

Create a Workspace Definition when the app needs durable file-tree behavior.

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
    }),
  },
  rules: {
    '/**': { write: false },
    '/drafts/**': { write: true, mediaType: 'text/markdown' },
  },
})
```

Source keys identify named origins inside the Workspace Source Map. A Source-Backed Path is read-only unless Workspace rules and runtime access allow writes elsewhere in the file tree.

Read [Configure](/docs/workspace/configure) for every Definition, Store, and Source Binding option.

## Connect Workspace to Agents

Workspace isn't automatically available to a model. Attach [`workspaceShell()`](/docs/workspace/agent-capability) when a model needs to inspect or edit files. Use `access()` when trusted invocation identity selects the Workspace Scope.

Read [Workspace and Sources](/docs/getting-started/concepts/workspace-and-sources) for the mental model and [Workspace context](/docs/agents/workspace-context) for Agent-specific composition.

## Next steps

- [Get started](/docs/workspace/get-started): install Workspace and make the first call from server code.
- [Configure](/docs/workspace/configure): select a Store and declare Source Bindings.
- [Server API](/docs/workspace/server-api): read, write, sync, and run sessions.
- [Agent capability](/docs/workspace/agent-capability): give an Agent file tools with `workspaceShell()`.
- [Hosts](/docs/workspace/hosts): generated output and Cloudflare Artifacts.
- [Limits and errors](/docs/workspace/limits-and-errors): Local Store checks and crash recovery.
- Use direct retrieval through [Source](/docs/source).
- Add command inspection with [Shell](/docs/shell).
- Expose file access to models through [Official capabilities](/docs/agents/capabilities/official).
