---
title: Agents
description: Define a server-side Agent, choose how it runs, and connect it to your application.
navigation.title: Overview
navigation.order: 20
navigation.group: Core
icon: i-lucide-bot
---

::product-hero{eyebrow="Any agent, anywhere" tagline="An Agent is one file under server/agents. Pick a Driver, give it a Workspace and Capabilities, connect a Channel, and ViteHub runs it on your host and records every Invocation."}
  :::agent-demo
  :::
::

::product-feature{label="Drivers" title="Bring any model or coding provider" to="/docs/agents/agent-drivers" link-label="Choose an Agent Driver"}
A Driver decides how one run executes. Point at a model string through AI Gateway, hand the run to Codex or Claude Code, ask a fixed set of typed questions, or run your own function.

The rest of the Definition does not change when the Driver does.

#code
```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'Answer support requests from inspected evidence.',
    execution: {
      callSettings: { temperature: 0.2 },
      stepLimit: 8,
    },
  },
})
```
::

::product-feature{label="Capabilities" title="Tools are the APIs your routes already call" to="/docs/agents/capabilities" link-label="Browse the Capabilities" reverse}
An Agent gets no access by default. A Capability wraps one server primitive and hands the Agent selected tools, with a mode, a scope, and a policy such as `require-approval`.

KV, Blob, Database, Email, Sandbox, Browser, and the Workspace shell ship as official Capabilities. MCP servers, skills, web search, and memory add the rest.

#code
```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { kv, workspaceShell } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  workspace: { mode: 'read' },
  capabilities: [
    workspaceShell({ mode: 'read' }),
    kv({ mode: 'write', policy: 'require-approval' }),
  ],
})
```
::

::product-feature{label="Workspace" title="It works in a real file tree" to="/docs/agents/workspace-context" link-label="Give an Agent files and Sources"}
A Workspace holds the files an Agent can reach: a repository checkout, a glob of documents, or records from a Source. It persists between runs, so a coding provider resumes where it stopped.

Read and write authority is explicit. The Workspace defines which files exist; Capabilities decide what the Agent may do with them.

#code
```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { workspaceShell } from 'vite-hub/agent/capabilities'
import { glob } from 'vite-hub/workspace'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  capabilities: [workspaceShell({ mode: 'read' })],
  workspace: {
    sourceRootDir: process.cwd(),
    sources: {
      docs: glob({ cwd: '.', include: ['docs/content/**/*.md'] }),
    },
  },
})
```
::

::product-feature{label="Channels" title="Reach it from chat, GitHub, Slack, or HTTP" to="/docs/agents/channels" link-label="Connect a Channel" reverse}
A Channel starts an Invocation from where the input lives. Web chat gets a generated AI SDK route. GitHub opens a run for a pull request. Discord, Slack, Teams, Telegram, Gmail, and HTTP are built in.

The Channel owns the transport. The Agent Actor carries the trusted identity of the caller.

#code
```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { github, webChat } from 'vite-hub/agent/channels'

export default defineAgent({
  channels: {
    portal: webChat(),
    github: github({ pullRequest: true }),
  },
  driver: { model: 'openai/gpt-5.1-mini' },
})
```
::

::product-feature{label="Invocations" title="Call it like a function, inspect it like a trace" to="/docs/agents/invocations" link-label="Run and observe an Invocation"}
Every call creates one Invocation with its input, its result or stream, and its trace. Call `runAgent()` from a route, a Schedule, or a script. Stream it with `streamAgent()`.

The CLI and the Console show each step, tool call, and approval of a run.

#code
```ts [server/api/support.post.ts]
import { runAgent } from 'vite-hub/agent'
import { getRuntimeContext } from 'vite-hub/runtime/h3'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const { prompt } = await readBody<{ prompt: string }>(event)
  const user = await requireAuthenticatedUser(event)

  return runAgent(support, getRuntimeContext(event), {
    prompt,
    context: { invoker: { id: user.id, kind: 'customer', label: user.email } },
  })
})
```
::

::product-feature{label="Presets" title="Start from a working harness" to="/docs/agents/babysitter" link-label="Deploy the Babysitter" reverse}
Babysitter is an Agent preset that repairs pull requests, waits for checks, and merges the ready ones. Extend it, filter the repositories and authors it serves, and add your own instructions next to the file.

Evals run repeatable scenarios against a Definition before you ship a change to it.

#code
```ts [server/agents/babysitter/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import { babysitter } from 'vite-hub/agent/presets/babysitter'

export default defineAgent({
  extends: babysitter,
  options: {
    filter: {
      repository: { allow: ['acme/app'] },
      author: { allow: ['octocat'] },
    },
    merge: 'direct',
    concurrency: 2,
  },
  driver: { model: 'gpt-5.6-sol' },
})
```
::
