---
title: Browser
navigation.title: Overview
description: Define provider-backed browser operations without exposing provider setup to application code.
navigation.order: 1
icon: i-lucide-monitor
---

::product-hero{tagline="Give each browser operation a name and run it from a route, Queue, or Workflow. ViteHub configures Cloudflare Browser Run, so application code does not import Cloudflare packages or pass browser credentials."}

```ts [server/api/page-html.post.ts]
import { runBrowser } from 'vite-hub/browser'

export default defineEventHandler(async (event) => {
  const input = await readBody<{ url: string }>(event)
  return await runBrowser('page-html', input)
})
```

::

::product-feature{label="Definitions" title="One file per browser operation, with an inferred input type" to="/docs/browser/server-api" link-label="Read the Browser server API"}
Put Browser Definitions in `server/browsers/` or name them `*.browser.ts`. The generated registry infers each Definition's input type for `runBrowser()`.

`runBrowser()` returns a native `Response`. Discovery and provider failures return a non-2xx JSON `Response`.

#code
```ts [server/browsers/page-html.ts]
import { defineBrowser } from 'vite-hub/browser'

export default defineBrowser(async (
  input: { url: string },
  { browser },
) => {
  return await browser.content(input.url)
})
```
::

::product-feature{label="Page sessions" title="Several interactions share one page, and ViteHub closes it" to="/docs/browser/server-api#keep-a-page-session-open" link-label="Keep a page session open" reverse}
`browser.open()` gives the Definition an invocation-owned page session. ViteHub closes it after the handler exits. Call `session.close()` to release it sooner.

Navigation and pointer clicks run one at a time. A timeout that leaves page state unclear invalidates the page.

#code
```ts [server/browsers/page-title.ts]
import { defineBrowser } from 'vite-hub/browser'

export default defineBrowser(async (input: { url: string }, { browser }) => {
  const session = await browser.open()
  await session.page.goto(input.url)
  await session.page.locator('main').waitFor()
  return await session.page.locator('h1').count()
})
```
::

::product-feature{label="Browser actions" title="One stateless call needs no Definition" to="/docs/browser/server-api#browser-actions" link-label="Run a Browser action"}
Run content, Markdown, links, screenshot, PDF, and the other Browser Run actions directly when the operation does not need a page session.

For Playwright, CDP, downloads, or live handoff, `createBrowser()` gives your code the low-level client. Your code then owns the provider, controllers, and cleanup.

#code
```ts [server/render-og.ts]
import { runBrowserContent } from 'vite-hub/browser/actions'

const html = await runBrowserContent('https://example.com')
```
::

::product-feature{label="Configure" title="Enable it on the Cloudflare preset" to="/docs/browser/configure" link-label="Configure Browser" reverse}
`browser: true` enables Browser Run actions. Use an object to change the binding, select the `chromium` session engine, or connect local development to the hosted service. Other presets throw a configuration error.

The build writes the Browser Run binding and the `nodejs_compat` flag to the generated `wrangler.json`.

#code
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
::

::product-feature{label="Agent capability" title="A Provider Agent gets its own browser CLI" to="/docs/browser/agent-capability" link-label="Give an Agent a browser"}
The `browser()` Capability gives a Provider Agent the `agent-browser` CLI, Chromium, and the official browser Skill. In managed mode, each Invocation gets its own browser session. Screenshots under `screenshots/` attach to the reply.

It does not call Browser Definitions. For a model-backed Agent, expose a narrow [custom Capability](/docs/agents/capabilities/custom) that calls `runBrowser()`.

#code
```ts [server/agents/review.ts]
import { defineAgent } from 'vite-hub/agent'
import { browser } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { kind: 'codex', model: 'gpt-6-astra' },
  workspace: { mode: 'write' },
  capabilities: [browser()],
})
```
::
