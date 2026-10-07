---

title: Run your first Shell command
description: Install Shell, mount a Workspace read-only, and inspect one command result.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Shell runs selected commands through an explicit Execution Provider. This
tutorial writes one fixture to a memory Workspace, mounts that Workspace
read-only, and searches it with Just Bash. The route returns a structured Shell
Observation that you can inspect.

::note
You need Node.js 24.15 or newer, `pnpm`, and an existing Vite server app. The
Just Bash provider is a controlled runtime for local development; use Sandbox
when you need provider-managed isolation.
::

::tutorial-step{title="Install and configure"}
## Install and configure

```bash [commands/install]
pnpm add @vite-hub/shell @vite-hub/workspace h3
pnpm add -D vite
```

Register Workspace discovery in `vite.config.ts`:

```ts [vite.config.ts]
import { hubWorkspace } from '@vite-hub/workspace/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubWorkspace()],
})
```

Create a writable memory Workspace for the local fixture:

```ts [server/workspaces/docs.ts]
import { defineWorkspace } from '@vite-hub/workspace'

export default defineWorkspace({
  store: { provider: 'memory' },
  rules: {
    '/**': { write: true, mediaType: 'text/markdown' },
  },
})
```

::

::tutorial-step{title="Run one command"}
## Run one command

Create a route that writes the fixture, then gives Shell a read-only adapter:

```ts [server/api/search-docs.get.ts]
import { defineEventHandler } from 'h3'
import { createShellRuntime } from '@vite-hub/shell'
import { createJustBashProvider } from '@vite-hub/shell/providers/just-bash'
import { createReadonlyWorkspaceFs, workspaceMountPoint } from '@vite-hub/shell/workspace'
import { useWorkspace } from '@vite-hub/workspace'

export default defineEventHandler(async () => {
  const workspace = useWorkspace('docs', { mode: 'write' })
  await workspace.fs.writeFile('README.md', '# ViteHub auth\n')

  const shell = createShellRuntime({
    policy: { maxOutputLength: 10_000, maxShellCalls: 1, timeout: 30_000 },
    provider: createJustBashProvider({
      commands: ['pwd', 'ls', 'cat', 'rg'],
      cwd: workspaceMountPoint,
      fs: createReadonlyWorkspaceFs(workspace.fs),
    }),
  })

  const observation = await shell.exec('rg auth .', { cwd: workspaceMountPoint })
  return {
    event: observation.event,
    exitCode: observation.exitCode,
    stdout: observation.stdout,
  }
})
```

The provider permits four commands, has no network access, and cannot write to
the mounted filesystem even though the route owns a writable Workspace.

::

::tutorial-step{title="Verify the result"}
## Verify the result

Start Vite and call the route:

```bash [commands/request]
pnpm vite dev
curl http://localhost:5173/api/search-docs
```

The response contains a successful observation:

```json [output/response.json]
{
  "event": "command_finished",
  "exitCode": 0,
  "stdout": "README.md:1:# ViteHub auth\n"
}
```

Read [Server API](/docs/shell/server-api) for sessions and command analysis,
then [Configuration](/docs/shell/configure) for provider boundaries and policy.
::
