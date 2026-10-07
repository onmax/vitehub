---

title: Read your first Source
description: Install ViteHub, define a Source, and read it from a server route.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Source gives server code a typed reader for files and other read-only data. This
tutorial reads the first Markdown file from a local glob Source.

::note
You need Node.js 24.15 or newer, `pnpm`, and an existing Vite server app. A
Source is read-only. Use [Workspace](/docs/workspace) when the application must
persist or mutate a file tree.
::

::tutorial-step{title="Install"}
## Install

```bash [commands/install]
pnpm add vite-hub nitro h3
pnpm add -D vite
```

::

::tutorial-step{title="Configure"}
## Configure

Direct Source reads need no configuration. The `vitehub()` Vite plugin and the Nuxt module add the generated Collection and Content routes.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node' }), nitro() as never],
})
```

::

::tutorial-step{title="Define a Source"}
## Define a Source

```ts [server/sources/docs.ts]
import { glob } from 'vite-hub/source/glob'

export const docs = glob({ cwd: 'docs', include: '**/*.md' })
```

Create `docs/intro.md` so the route has a known file to read:

```md [docs/intro.md]
# Hello from Source

This file is loaded by the glob Source.
```

```ts [server/api/docs.get.ts]
import { defineEventHandler } from 'h3'
import { createSource } from 'vite-hub/source'
import { docs } from '../sources/docs'

export default defineEventHandler(async () => {
  const reader = createSource(docs)
  return reader.read('intro.md')
})
```

`createSource(definition, context?)` opens a reader directly. It infers keys, items, and metadata from the definition. No registry or global type map is needed.

::

::tutorial-step{title="Read one file"}
## Read one file

Start Vite and call the route:

```bash [commands/request]
pnpm vite dev
curl http://localhost:5173/api/docs
```

The response contains the first Markdown file in the `docs` directory. Read
[Configure](/docs/source/configure) when the Source should load GitHub,
collections, or a custom data store.

::
