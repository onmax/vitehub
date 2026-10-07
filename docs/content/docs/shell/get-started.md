---
title: Run your first Shell command
description: Install Shell, create a Shell Runtime, and run a first command.
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/shell @vite-hub/workspace
```

### Configure

```ts [server/tasks/search-docs.ts]
import { createShellRuntime } from '@vite-hub/shell'
import { createJustBashProvider } from '@vite-hub/shell/providers/just-bash'
import { createReadonlyWorkspaceFs, workspaceMountPoint } from '@vite-hub/shell/workspace'
import { useWorkspace } from '@vite-hub/workspace'

const workspace = useWorkspace('docs')
const shell = createShellRuntime({
  policy: { maxOutputLength: 10_000, timeout: 30_000 },
  provider: createJustBashProvider({
    commands: ['pwd', 'ls', 'cat', 'rg'],
    cwd: workspaceMountPoint,
    fs: createReadonlyWorkspaceFs(workspace.fs),
  }),
})
```

### Start using it

```ts [server/tasks/search-docs.ts]
const observation = await shell.exec('rg auth .', { cwd: workspaceMountPoint })
```

::

The provider controls which commands exist. The Workspace filesystem adapter controls whether writes can happen. This example permits four commands, has no network access, and cannot write.
