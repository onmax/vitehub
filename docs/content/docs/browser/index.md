---
title: Browser
navigation.title: Overview
description: Define provider-backed browser operations without exposing provider setup to application code.
navigation.order: 1
icon: i-lucide-monitor
---

::product-hero{tagline="Name a browser operation and run it from a route, Queue, or Workflow, with no Cloudflare imports or credentials."}
  :::code-group
  ```ts [Route]
  import { runBrowser } from 'vite-hub/browser'

  export default defineEventHandler(async (event) => {
    const input = await readBody<{ url: string }>(event)
    return await runBrowser('page-html', input)
  })
  ```

  ```ts [Definition]
  import { defineBrowser } from 'vite-hub/browser'

  export default defineBrowser(async (
    input: { url: string },
    { browser },
  ) => {
    return await browser.content(input.url)
  })
  ```

  ```ts [vite.config.ts]
  import { vitehub } from 'vite-hub'
  import { defineConfig } from 'vite'

  export default defineConfig({
    plugins: [
      vitehub({
        preset: 'cloudflare',
        browser: {
          binding: 'RENDER_BROWSER',
          remote: true,
        },
      }),
    ],
  })
  ```

  ```ts [Agent]
  import { defineAgent } from 'vite-hub/agent'
  import { browser } from 'vite-hub/agent/capabilities'

  export default defineAgent({
    driver: { kind: 'codex', model: 'gpt-6-astra' },
    workspace: { mode: 'write' },
    capabilities: [browser()],
  })
  ```
  :::
::

::product-features
  :::product-feature-item{title="One file per browser operation" icon="i-lucide-code-2" to="/docs/browser/server-api" link-label="Browser server API"}
  Definitions in `server/browsers/` or `*.browser.ts` get an inferred input type, and `runBrowser()` returns a native `Response`.
  :::

  :::product-feature-item{title="Several interactions share one page" icon="i-lucide-monitor" to="/docs/browser/server-api#keep-a-page-session-open" link-label="Keep a page session open"}
  `browser.open()` gives a Definition a page session that ViteHub closes when the handler exits, or sooner with `session.close()`.
  :::

  :::product-feature-item{title="One stateless call needs no Definition" icon="i-lucide-play-circle" to="/docs/browser/server-api#browser-actions" link-label="Browser actions"}
  Run content, Markdown, links, screenshot, PDF, and other Browser Run actions directly when the operation needs no page session.
  :::

  :::product-feature-item{title="Enable it on the Cloudflare preset" icon="i-lucide-cloud-cog" to="/docs/browser/configure" link-label="Configure Browser"}
  `browser: true` enables Browser Run, and the build writes its binding and the `nodejs_compat` flag to `wrangler.json`.
  :::

  :::product-feature-item{title="A Provider Agent gets its own browser CLI" icon="i-lucide-bot" to="/docs/browser/agent-capability" link-label="Browser Agent capability"}
  The `browser()` Capability gives a Provider Agent the `agent-browser` CLI, Chromium, and the official browser Skill.
  :::

  :::product-feature-item{title="Model-backed Agents need a custom Capability" icon="i-lucide-plug" to="/docs/agents/capabilities/custom" link-label="Custom capabilities"}
  The `browser()` Capability does not call Browser Definitions, so give a model-backed Agent a custom Capability that calls `runBrowser()`.
  :::
::
