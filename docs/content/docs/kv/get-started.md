---

title: Store your first KV value
description: Install KV, write and read one key, and verify the local result.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

KV stores small JSON-compatible values behind one key-value API. This tutorial
uses the local file-backed driver, so the first write and read work without a
provider account.

::note
You need Node.js 24.15 or newer, `pnpm`, and an existing Vite server app. The
local driver persists under `.vitehub/data/kv`; choose a hosted driver before
running more than one process.
::

::tutorial-step{title="Install and configure"}
## Install and configure

```bash [commands/install]
pnpm add @vite-hub/kv nitro h3
pnpm add -D vite
```

Register KV in `vite.config.ts`:

```ts [vite.config.ts]
import { hubKv } from '@vite-hub/kv/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [hubKv(), nitro() as never],
})
```

::

::tutorial-step{title="Write and read one key"}
## Write and read one key

Create a route that writes a request body, then reads the same key:

```ts [server/api/settings.put.ts]
import { defineEventHandler, readBody } from 'h3'
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async (event) => {
  const settings = await readBody<{ theme: string }>(event)
  const [writeError] = await kv.set('settings', settings)
  if (writeError) throw writeError

  const [readError, storedSettings] = await kv.get<{ theme: string }>('settings')
  if (readError) throw readError
  return { settings: storedSettings }
})
```

`kv.set()` and `kv.get()` return `[error, value]` tuples. Check the first slot
before using a value.

::

::tutorial-step{title="Verify the result"}
## Verify the result

Start Vite and send one request:

```bash [commands/request]
pnpm vite dev
curl -X PUT http://localhost:5173/api/settings \
  -H 'content-type: application/json' \
  -d '{"theme":"system"}'
```

The route returns the value read from KV:

```json [output/response.json]
{ "settings": { "theme": "system" } }
```

Stop and restart the dev server, then send the request again. The `fs-lite`
driver keeps the value under `.vitehub/data/kv`. Continue with
[Configuration](/docs/kv/configure) for named stores and
[Hosts](/docs/kv/hosts) before choosing a production driver.
::
