---
title: Browser
navigation.title: Overview
description: Define provider-backed browser operations without exposing provider setup to application code.
navigation.order: 1
icon: i-lucide-monitor
---

Use a Browser Definition when trusted server code needs to inspect a page, render browser-only UI, take a screenshot, or create a PDF. Give each operation a name, then call it from a route, Queue, or Workflow.

Browser Definitions run through Cloudflare Browser Run and require the Cloudflare preset. ViteHub configures the provider, so application code does not import Cloudflare packages or pass browser credentials. Browser works without Agents.

::tip
- **Browser Definition** (`defineBrowser`, `runBrowser`): a named operation with an invocation-owned page session. Use this by default.
- **Browser action** (`runBrowserAction`, `runBrowserContent`): one stateless call, such as content, screenshot, or PDF, with no Definition.
- **Low-level client** (`createBrowser`): you own provider selection, controllers, cleanup, and live handoff.
- **[`browser()` Capability](/docs/browser/agent-capability)**: gives a Provider Agent its own `agent-browser` CLI. It does not call this primitive.
::

## Example

```ts [server/browsers/page-html.ts]
import { defineBrowser } from 'vite-hub/browser'

export default defineBrowser(async (
  input: { url: string },
  { browser },
) => {
  return await browser.content(input.url)
})
```

Server code runs it by name with `runBrowser('page-html', { url })`.

## Connect Browser to Agents

The [`browser()` Capability](/docs/browser/agent-capability) gives a Provider Agent the `agent-browser` CLI, Chromium, and the official browser Skill. It runs through the provider's native shell and does not use Browser Definitions. For a model-backed Agent, expose a narrow [custom Capability](/docs/agents/capabilities/custom) that calls `runBrowser()`.

## Next steps

- [Get started](/docs/browser/get-started): enable Browser and run a first Definition.
- [Configure](/docs/browser/configure): change the binding, engine, or remote mode.
- [Server API](/docs/browser/server-api): call Definitions, actions, and low-level sessions.
- [Agent capability](/docs/browser/agent-capability): give a Provider Agent its own browser.
- [Hosts](/docs/browser/hosts): check provider and host support.
- [Limits and errors](/docs/browser/limits-and-errors): timeouts, handoff limits, and production checks.
- Store screenshots and downloaded files with [Blob](/docs/blob).
- Deploy Browser Run output on [Cloudflare](/docs/frameworks-hosts/cloudflare).
