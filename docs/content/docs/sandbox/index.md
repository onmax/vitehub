---
title: Sandbox
navigation.title: Overview
description: Run named package projects in an isolated Cloudflare or Vercel Sandbox.
navigation.order: 1
icon: i-lucide-terminal-square
---

::product-hero{tagline="Run a named package project in an isolated Box, on Cloudflare or Vercel Sandbox chosen in config."}
  :::code-group
  ```ts [Route]
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

  ```ts [Definition]
  interface SandboxPayload {
    notes?: string
  }

  export default async function releaseNotes(payload: SandboxPayload = {}) {
    return { text: payload.notes?.toUpperCase() || 'No notes' }
  }
  ```

  ```ts [vite.config.ts]
  import { hubSandbox } from '@vite-hub/sandbox/vite'
  import { defineConfig } from 'vite'

  export default defineConfig({
    plugins: [hubSandbox({ provider: 'vercel' })],
  })
  ```

  ```ts [Agent]
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
  :::
::

::product-features
  :::product-feature-item{title="A Sandbox is a package project" icon="i-lucide-box" to="/docs/sandbox/configure" link-label="Configure Sandbox"}
  Each folder under `server/sandboxes` is one package project, named by its path, with dependencies installed inside the Box.
  :::

  :::product-feature-item{title="Every run returns a native Response" icon="i-lucide-code-2" to="/docs/sandbox/server-api" link-label="Sandbox server API"}
  `runSandbox()` infers the payload type, and failures, including a `SANDBOX_TIMEOUT`, return a non-2xx JSON `Response`.
  :::

  :::product-feature-item{title="Pick the provider in config, not the Definition" icon="i-lucide-cloud-cog" to="/docs/sandbox/hosts" link-label="Sandbox hosts"}
  Vercel Sandbox and Cloudflare Sandbox run the same Definitions, both on remote, potentially billed infrastructure.
  :::

  :::product-feature-item{title="The Box is the boundary" icon="i-lucide-shield-alert" to="/docs/sandbox/limits-and-errors" link-label="Sandbox limits and errors"}
  Code in the Box can use the filesystem, network, credentials, and child processes the provider exposes, so read `executionAuthority` first.
  :::

  :::product-feature-item{title="Allowlisted executables, as one Agent tool" icon="i-lucide-bot" to="/docs/sandbox/agent-capability" link-label="Sandbox Agent capability"}
  The `sandbox()` Capability gives an Agent `sandbox_exec`, which runs only executable names from `commands`, never shell command strings.
  :::

  :::product-feature-item{title="Not for single commands or durable files" icon="i-lucide-git-branch" to="/docs/shell" link-label="Compare Shell"}
  Use Shell to run single commands with a declared policy, and Workspace for durable files.
  :::
::
