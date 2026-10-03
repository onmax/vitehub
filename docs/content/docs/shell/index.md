---
title: Shell
navigation.title: Overview
description: Run Unix-like commands with configured filesystem, process, network, timeout, and policy access.
navigation.order: 1
icon: i-lucide-terminal
---

::product-hero{tagline="Run Unix-like commands from server code through an Execution Provider such as Just Bash or Cloudflare. The provider and its filesystem adapter decide which commands, files, and network a command can reach."}

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

::

::product-feature{label="Server API" title="Each command returns a Shell Observation" to="/docs/shell/server-api" link-label="Read the Shell server API"}
An Observation holds the event, exit code, stdout, stderr, and flags for truncated output and timeouts. A policy denial is also an Observation, with exit code `126`, not a thrown error.

A Shell Session keeps one policy across repeated commands: call budget, output size, timeouts, and process budget.

#code
```ts [server/tasks/inspect-docs.ts]
import { createShellRuntime } from '@vite-hub/shell'

export async function inspect(runtime: ReturnType<typeof createShellRuntime>) {
  const session = runtime.createSession({
    policy: {
      maxOutputLength: 10_000,
      maxShellCalls: 4,
      timeout: 30_000,
    },
  })

  try {
    return await session.exec('pwd')
  }
  finally {
    await session.dispose()
  }
}
```
::

::product-feature{label="Command analysis" title="Read the facts of a command before it runs" to="/docs/shell/server-api#analyze-commands" link-label="Analyze commands" reverse}
`analyzeShellCommand()` parses a command and reports its executables and flags for pipelines, redirects, heredocs, and command substitution. Your code makes the final policy decision.

Analysis is not sandbox enforcement. The Execution Provider and your policy control what the command can do.

#code
```ts [server/tasks/analyze-command.ts]
import { analyzeShellCommand } from '@vite-hub/shell'

const analysis = await analyzeShellCommand('rg TODO src')
// analysis.commands: ['rg'], analysis.hasPipelines: false, analysis.ok: true
```
::

::product-feature{label="Agent tool" title="Agents get Shell through the Workspace shell" to="/docs/workspace/agent-capability" link-label="Give an Agent the Workspace shell"}
Do not expose a raw Shell Runtime to a model. The `workspaceShell()` Capability gives an Agent a `shell` tool for Workspace inspection. Write mode adds structured file mutation tools that follow Workspace rules.

The Shell policy and the Workspace Scope stay attached to the Agent Definition.

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

::product-feature{label="Commands" title="Provider Drivers run allowlisted executables in the Workspace" to="/docs/workspace/agent-capability" link-label="Configure Workspace commands" reverse}
With `commands`, a Provider Driver gets a `workspace_exec` tool. It runs one allowlisted executable in the active Workspace Session, so its changes are part of the provider result.

`commands` requires `mode: 'write'`. For model-backed Agents, use the [`sandbox()` Capability](/docs/sandbox/agent-capability).

#code
```ts [server/agents/coder.ts]
import { defineAgent } from 'vite-hub/agent'
import { workspaceShell } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { kind: 'codex' },
  workspace: { mode: 'write' },
  capabilities: [workspaceShell({ commands: ['git'], mode: 'write', timeout: 30_000 })],
})
```
::
