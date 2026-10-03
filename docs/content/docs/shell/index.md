---
title: Shell
navigation.title: Overview
description: Run Unix-like commands with configured filesystem, process, network, timeout, and policy access.
navigation.order: 1
icon: i-lucide-terminal
---

Use Shell when server code needs to inspect or change files through Unix-like commands. A Shell Runtime sends each command to an Execution Provider. You choose the commands, files, network access, processes, and timeouts that each provider allows.

Each call returns a structured Shell Observation with the exit code, output, and policy events. Shell works without Agents.

::tip
- [Workspace](/docs/workspace) stores the file tree. Shell can mount it read-only or writable.
- [Source](/docs/source) reads external content. It does not run commands.
- [Sandbox](/docs/sandbox) runs a whole package project in a provider-managed Box. Use it when work needs isolation.
- Shell runs single commands with session policy and command analysis. A Shell boundary describes a provider contract. It is not proof of operating-system isolation.
::

## Example

This Shell Runtime permits four read-only commands against a Workspace:

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

const observation = await shell.exec('rg auth .', { cwd: workspaceMountPoint })
```

## Connect Shell to Agents

Agents use Shell through the [`workspaceShell()` Capability](/docs/workspace/agent-capability). It exposes shell-shaped Workspace inspection and optional structured Workspace mutation tools through Workspace Scope, Workspace rules, and Shell policy.

To let an Agent run commands, use the same Capability. `workspaceShell({ mode: 'write', commands: ['pnpm'] })` gives Provider Drivers allowlisted command tools that run in the active Workspace Session. `commands` requires `mode: 'write'` and works only with Provider Drivers. For model-backed Agents, use the [`sandbox()` Capability](/docs/sandbox/agent-capability).

Do not expose a raw Shell Runtime to a model. Use [Official capabilities](/docs/agents/capabilities/official) so policy, metadata, Driver support, and tools stay attached to the Agent Definition.
