---

title: Send through your first Channel
description: Install Channels, send a local delivery, and then connect a provider.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Channels gives server code one named destination for outbound messages. This
tutorial uses a local `log` connector, so the first delivery needs no provider
account. Replace it with Telegram, Slack, or your own connector after the
contract works.

::note
You need Node.js 24.15 or newer, `pnpm`, and an existing Vite server app.
::

::tutorial-step{title="Install and enable discovery"}
## Install and enable discovery

Install the ViteHub distribution and the Channels integration:

```bash [commands/install]
pnpm add vite-hub nitro h3 vite
```

Add the Channels integration to your Vite config. ViteHub then discovers files below `server/channels` and files that end in `.channel.ts`.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', channels: true }), nitro() as never],
})
```

The local connector does not need Server Env. Add a secret declaration only
when a connector calls a provider API.

::

::tutorial-step{title="Define a named Channel"}
## Define a named Channel

Create `server/channels/alerts.ts` with `defineOutboundChannel()`. The `log`
connector returns a receipt that we can inspect without sending a real message.

```ts [server/channels/alerts.ts]
import { defineOutboundChannel } from 'vite-hub/channels'
export default defineOutboundChannel({
  connectors: {
    log: {
      send(text: string, { label }: { label: string }) {
        console.log(`[${label}] ${text}`)
        return { id: `log-${label}` }
      },
    },
  },
})
```

The file name becomes the Channel name. For a Vite suffix definition, use `src/alerts.channel.ts` instead; both forms discover the same `alerts` Channel.

::

::tutorial-step{title="Send and verify one delivery"}
## Send and verify one delivery

Create a route that sends through the discovered Channel:

```ts [server/api/build-finished.post.ts]
import { defineEventHandler } from 'h3'
import { useChannel } from 'vite-hub/channels/server'

export default defineEventHandler(async () => {
  const [error, receipt] = await useChannel('alerts').send('Build finished.', {
    connector: 'log',
    label: 'release',
  })
  if (error) throw error
  return receipt
})
```

Start the dev server and send one request:

```bash [commands/request]
pnpm vite dev
curl -X POST http://localhost:5173/api/build-finished
```

The response includes a generated delivery id and the connector id:

```json [output/response.json]
{
  "channel": "alerts",
  "connector": "log",
  "deliveryId": "...",
  "id": "log-release"
}
```

Channels does not bundle provider adapters or retry deliveries. For a real
connector, read typed Server Env inside `send()` and keep credentials out of
client code. Continue with [Send from an H3 or Nitro handler](/docs/channels/server-api#send-from-an-h3-or-nitro-handler).
::
