---

title: Read your first Source
description: Install ViteHub, define a Source, and read it from a server route.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Install ViteHub, define a Source, and read it from server code.

## Quick start

::tutorial-step{title="Install"}
### Install

```bash [Terminal]
pnpm add vite-hub
```

::

::tutorial-step{title="Configure"}
### Configure

Direct Source reads need no configuration. The `vitehub()` Vite plugin and the Nuxt module add the generated Collection and Content routes.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node' })],
})
```

::

::tutorial-step{title="Start using it"}
### Start using it

```ts [server/sources/docs.ts]
import { glob } from 'vite-hub/source/glob'

export const docs = glob({ cwd: 'docs', include: '**/*.md' })
```

```ts [server/api/docs.get.ts]
import { createSource } from 'vite-hub/source'
import { docs } from '../sources/docs'

export default defineEventHandler(async () => {
  const reader = createSource(docs)
  return reader.read('intro.md')
})
```

`createSource(definition, context?)` opens a reader directly. It infers keys, items, and metadata from the definition. No registry or global type map is needed.

::
