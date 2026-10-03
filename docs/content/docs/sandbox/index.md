---
title: Sandbox
navigation.title: Overview
description: Run named package projects in an isolated Cloudflare or Vercel Sandbox.
navigation.order: 1
icon: i-lucide-terminal-square
---

::product-hero{tagline="Run a named package project in an isolated Box, on Cloudflare or Vercel Sandbox chosen in config." providers="Vercel, Cloudflare"}
  :::code-group
  ```ts [Definition and route]
  // server/sandboxes/release-notes/index.ts
  interface SandboxPayload {
    notes?: string
  }

  export default async function releaseNotes(payload: SandboxPayload = {}) {
    return { text: payload.notes?.toUpperCase() || 'No notes' }
  }

  // server/api/release-notes-json.post.ts
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

::product-flow{caption="Every run returns a native Response, including failures and timeouts."}
  :::product-flow-step{label="Route" detail="runSandbox(name, payload)"}
  :::
  :::product-flow-step{label="Provider" detail="vercel · cloudflare"}
  :::
  :::product-flow-step{label="Box" detail="package.json · install"}
  :::
  :::product-flow-step{label="Entrypoint" detail="index.ts default export"}
  :::
  :::product-flow-step{label="Response" detail="Response · SANDBOX_TIMEOUT"}
  :::
::

::product-features
  :::product-feature-item{title="A Sandbox is a package project" icon="i-lucide-box" to="/docs/sandbox/configure"}
  One folder under `server/sandboxes`, with `package.json` and an entrypoint.
  :::

  :::product-feature-item{title="Every run returns a native Response" icon="i-lucide-code-2" to="/docs/sandbox/server-api"}
  Failures and `SANDBOX_TIMEOUT` return a non-2xx JSON `Response`.
  :::

  :::product-feature-item{title="Pick the provider in config, not the Definition" icon="i-lucide-cloud-cog" to="/docs/sandbox/hosts"}
  Vercel Sandbox and Cloudflare Sandbox run the same Definitions.
  :::

  :::product-feature-item{title="The Box is the boundary" icon="i-lucide-shield-alert" to="/docs/sandbox/limits-and-errors"}
  Box code reaches what the provider exposes; read `executionAuthority` first.
  :::

  :::product-feature-item{title="Allowlisted executables, as one Agent tool" icon="i-lucide-bot" to="/docs/sandbox/agent-capability"}
  `sandbox_exec` runs only executable names listed in `commands`.
  :::

  :::product-feature-item{title="Not for single commands or durable files" icon="i-lucide-git-branch" to="/docs/shell"}
  Use Shell for single commands and Workspace for durable files.
  :::
::
