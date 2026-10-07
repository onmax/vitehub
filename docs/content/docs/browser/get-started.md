---

title: Run your first Browser Definition
description: Install ViteHub, enable Browser on the Cloudflare preset, and run a first Browser Definition.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Browser runs named operations in a provider-managed browser session. This
tutorial uses Cloudflare Browser Run and returns the page HTML from one route.

::note
You need Node.js 24.15 or newer, `pnpm`, a Cloudflare account, and an existing
Vite server app. Browser is available on the Cloudflare preset. For a trusted
Node process, use the local provider in [Hosts](/docs/browser/hosts).
::

::tutorial-step{title="Install"}
## Install

```bash [commands/install]
pnpm add vite-hub h3
pnpm add -D vite
```

::

::tutorial-step{title="Configure"}
## Configure

Enable Browser on the Cloudflare deployment preset.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'

export default {
  plugins: vitehub({
    preset: 'cloudflare',
    browser: true,
  }),
}
```

::

::tutorial-step{title="Define a browser operation"}
## Define a browser operation

Place Browser Definitions in `server/browsers/` or name them `*.browser.ts`.

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

::tutorial-step{title="Run it by name"}
## Run it by name

```ts [server/api/page-html.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { runBrowser } from 'vite-hub/browser'

export default defineEventHandler(async (event) => {
  const input = await readBody<{ url: string }>(event)
  return await runBrowser('page-html', input)
})
```

::


The generated Browser registry infers each Definition's input type. `runBrowser()` returns a native `Response`. Discovery and provider failures return a non-2xx JSON `Response`.

::tutorial-step{title="Verify the response"}
## Verify the response

Start Vite and send a URL to the route:

```bash [commands/request]
pnpm vite dev
curl -X POST http://localhost:5173/api/page-html \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
```

The response is the HTML returned by the Browser provider. Read
[Server API](/docs/browser/server-api) for page sessions, screenshots, and
stateless actions.

::
