---
title: Sandbox
navigation.title: Overview
description: Run named package projects in an isolated Cloudflare or Vercel Sandbox.
navigation.order: 1
icon: i-lucide-terminal-square
---

::product-hero{tagline="Run a named package project in an isolated Box. Your route calls it by name, and Cloudflare Sandbox or Vercel Sandbox runs the process."}

```ts [server/api/release-notes.post.ts]
import { runSandbox } from '@vite-hub/sandbox'

export default defineEventHandler(async () => {
  return runSandbox('release-notes', { notes: 'ship it' })
})
```

::

::product-feature{label="Definitions" title="A Sandbox is a package project with a default export" to="/docs/sandbox/configure" link-label="Lay out Sandbox package projects"}
Each folder under `server/sandboxes` is one package project. The folder path supplies the Definition name. ViteHub installs the dependencies inside the Box and does not write them back to your repository.

Outside that folder, a `<path>.sandbox.ts` file can default-export `defineSandbox()` instead.

#code
```json [server/sandboxes/release-notes/package.json]
{
  "private": true,
  "type": "module",
  "vitehub": {
    "sandbox": {
      "timeout": 30000
    }
  }
}
```

```ts [server/sandboxes/release-notes/index.ts]
interface SandboxPayload {
  notes?: string
}

export default async function releaseNotes(payload: SandboxPayload = {}) {
  return { text: payload.notes?.toUpperCase() || 'No notes' }
}
```
::

::product-feature{label="Server API" title="Every run returns a native Response" to="/docs/sandbox/server-api" link-label="Read the Sandbox server API" reverse}
`runSandbox()` infers the payload type from the default function. Failures, including timeouts, return a non-2xx JSON `Response`. A timed-out attempt returns the `SANDBOX_TIMEOUT` code.

Nested `Blob` and `Uint8Array` values cross the Box boundary without a base64 conversion.

#code
```ts [server/api/release-notes-json.post.ts]
import { runSandbox } from '@vite-hub/sandbox'

export default defineEventHandler(async () => {
  const response = await runSandbox('release-notes', { notes: 'ship it' }, {
    context: { requestId: 'release-notes-42' },
  })
  if (!response.ok)
    throw new Error(await response.text())
  return await response.json()
})
```
::

::product-feature{label="Hosts" title="Pick the provider in config, not in the Definition" to="/docs/sandbox/hosts" link-label="See providers and host support"}
Vercel Sandbox and Cloudflare Sandbox run the same Definitions. The `cloudflare` and `vercel` presets select the matching provider. For Cloudflare, the build writes the Container, Durable Object binding, and Worker exports to Provider Output.

Sandbox has no local in-process provider. Both providers run remote, potentially billed infrastructure.

#code
```ts [vite.config.ts]
import { hubSandbox } from '@vite-hub/sandbox/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubSandbox({ provider: 'vercel' })],
})
```

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'

export default {
  plugins: vitehub({ preset: 'vercel', sandbox: true }),
}
```
::

::product-feature{label="Isolation" title="The Box is the boundary, so inspect its authority" to="/docs/sandbox/limits-and-errors" link-label="Check limits before production" reverse}
A Definition name and its payload select work. They are not a permission boundary. Code inside the Box can use the filesystem, network, credentials, and child processes that the provider exposes. Read the runner's `executionAuthority` before execution when your policy depends on it.

Use [Shell](/docs/shell) to run single commands with a declared policy, and [Workspace](/docs/workspace) for durable files.

#code
```ts [server/sandbox-authority.ts]
import { resolveSandboxRunner } from '@vite-hub/sandbox'

const runner = await resolveSandboxRunner('release-notes')
console.log(runner.executionAuthority)
```
::

::product-feature{label="Agent capability" title="Allowlisted executables, as one tool for an Agent" to="/docs/sandbox/agent-capability" link-label="Give an Agent the Sandbox"}
Installing Sandbox gives no model access to it. Attach the `sandbox()` Capability to give an Agent the `sandbox_exec` tool. The tool runs only executable names from `commands`, never shell command strings.

An allowlisted executable can run any code that its arguments select. The isolation of the Sandbox primitive is the security boundary.

#code
```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { sandbox } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  workspace,
  capabilities: [
    sandbox({ commands: ['node', 'pnpm'] }),
  ],
})
```
::
