---
title: Browser get started
description: Install ViteHub, enable Browser on the Cloudflare preset, and run a first Browser Definition.
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add vite-hub
```

### Configure

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

### Define a browser operation

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

### Run it by name

```ts [server/api/page-html.post.ts]
import { runBrowser } from 'vite-hub/browser'

export default defineEventHandler(async (event) => {
  const input = await readBody<{ url: string }>(event)
  return await runBrowser('page-html', input)
})
```

::

The generated Browser registry infers each Definition's input type. `runBrowser()` returns a native `Response`. Discovery and provider failures return a non-2xx JSON `Response`.
