---
title: Sandbox
navigation.title: Overview
description: Run named package projects in an isolated Cloudflare or Vercel Sandbox.
navigation.order: 1
icon: i-lucide-terminal-square
---

Use a Sandbox Definition to run a named package project in an isolated Box. The package supplies the code and dependencies. The Box provider (Cloudflare Sandbox or Vercel Sandbox) runs the process. Server code calls the Definition by name and gets a native Web `Response`.

Use Sandbox when work needs its own dependencies, a real filesystem, or child processes that must not run in your server process. Sandbox works without Agents.

::tip
- [Workspace](/docs/workspace) stores durable files and handles Sources, snapshots, diffs, commits, and rollbacks.
- [Source](/docs/source) reads content from an external location. It does not run code.
- Sandbox discovers Definitions, prepares package projects, serializes values, applies timeouts, and coordinates each run.
- [Shell](/docs/shell) runs Unix-like commands with a declared policy through a Shell provider.
- [Box](/docs/agents/boxes) provides process isolation, runtime files, caches, ports, and provider-specific deployment output. Sandbox runs on a Box. Workspace never selects a Box provider.
::

## Example

A package project under `server/sandboxes/release-notes/` default-exports a function. Server code runs it by name:

```ts [server/api/release-notes.post.ts]
import { runSandbox } from '@vite-hub/sandbox'

export default defineEventHandler(async () => {
  return runSandbox('release-notes', { notes: 'ship it' })
})
```

## Connect Sandbox to Agents

Agents receive Sandbox through the [`sandbox()` Capability](/docs/sandbox/agent-capability). With `commands`, it gives a model-backed Agent an allowlisted `sandbox_exec` tool that delegates to this primitive.
