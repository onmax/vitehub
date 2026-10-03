---
title: Agents
description: Define a server-side Agent, choose how it runs, and connect it to your application.
navigation.title: Overview
navigation.order: 20
navigation.group: Core
icon: i-lucide-bot
---

::product-hero{eyebrow="Any agent, anywhere" tagline="One file under server/agents: a Driver, a Workspace, Capabilities, and Channels, run and recorded on your host."}
  :::agent-demo
  :::
::

::product-features
  :::product-feature-item{title="Bring any model or coding provider" icon="i-lucide-cpu" to="/docs/agents/agent-drivers" link-label="Agent Drivers"}
  A Driver runs one Invocation: a model through AI Gateway, Codex or Claude Code, typed questions, or your own function.
  :::

  :::product-feature-item{title="Tools are the APIs your routes already call" icon="i-lucide-blocks" to="/docs/agents/capabilities" link-label="Capabilities"}
  A Capability wraps one server primitive and hands the Agent selected tools with a mode, a scope, and a policy such as `require-approval`.
  :::

  :::product-feature-item{title="It works in a real file tree" icon="i-lucide-folder-git-2" to="/docs/agents/workspace-context" link-label="Workspace context"}
  A Workspace holds the files and Sources the Agent can reach, and persists between runs. Access stays explicit.
  :::

  :::product-feature-item{title="Reach it from chat, GitHub, Slack, or HTTP" icon="i-lucide-radio" to="/docs/agents/channels" link-label="Channels"}
  A Channel starts an Invocation from where the input lives: web chat, GitHub, Discord, Slack, Teams, Telegram, Gmail, or HTTP.
  :::

  :::product-feature-item{title="Call it like a function, inspect it like a trace" icon="i-lucide-play-circle" to="/docs/agents/invocations" link-label="Invocations"}
  `runAgent()` and `streamAgent()` create one Invocation with its input, result, and trace, visible in the CLI and the Console.
  :::

  :::product-feature-item{title="Protect behavior with Evals" icon="i-lucide-clipboard-check" to="/docs/agents/evals" link-label="Evals"}
  Run repeatable scenarios against a Definition and score the result before you ship a change to it.
  :::
::
