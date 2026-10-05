---
title: Workspace get started
description: Install Workspace, register the Vite integration, define a Workspace, and read and write files from server code.
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Install the Workspace package, register the Vite integration, and make the first call from server code.

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/workspace
```

### Configure

```ts [vite.config.ts]
import { hubWorkspace } from '@vite-hub/workspace/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubWorkspace()],
})
```

### Start using it

```ts [server/workspaces/docs.ts]
import { defineWorkspace, glob } from '@vite-hub/workspace'

export default defineWorkspace({
  sources: {
    docs: glob({ include: ['docs/**/*.md'] }),
  },
})
```

::

## Use it at runtime

Read files from server code with `useWorkspace()`.

```ts [server/api/docs.get.ts]
import { useWorkspace } from '@vite-hub/workspace'

export default defineEventHandler(async () => {
  const workspace = useWorkspace('docs')
  return workspace.fs.glob('**/*.md')
})
```

Request write access only at the call site that needs mutation.

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
