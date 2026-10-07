---
title: Send through your first Channel
description: Enable Channel discovery and define the first named Channel.
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

## Enable Channel discovery

Add the Channels integration to your Vite config. ViteHub then discovers files below `server/channels` and files that end in `.channel.ts`.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', channels: true })],
  env: {
    server: {
      telegram: {
        botToken: env({
          secret: true,
          source: env.source('TELEGRAM_BOT_TOKEN'),
        }),
      },
    },
  },
})
```

## Define a named Channel

Create `server/channels/alerts.ts` with `defineOutboundChannel()`. Read typed Server Env inside the connector's `send()` method so the value is resolved when the message is delivered. Unseal a secret only when the provider call needs the raw value.

```ts [server/channels/alerts.ts]
import { defineOutboundChannel } from 'vite-hub/channels'
import { useServerEnv } from '#vitehub/env/server'

type TelegramOptions = {
  chatId: string
}

export default defineOutboundChannel({
  connectors: {
    telegram: {
      async send(text: string, { chatId }: TelegramOptions) {
        const { telegram } = useServerEnv()
        const response = await fetch(`https://api.telegram.org/bot${telegram.botToken.unseal()}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        })
        if (!response.ok) throw new Error(`Telegram returned ${response.status}.`)
        const result = await response.json() as { result?: { message_id?: number } }
        return { id: result.result?.message_id?.toString() }
      },
    },
  },
})
```

This example calls Telegram directly to keep the connector contract visible; use a provider client when your application already has one. Channels does not bundle provider adapters. For a connector that does not need credentials, omit the `useServerEnv()` call.

The file name becomes the Channel name. For a Vite suffix definition, use `src/alerts.channel.ts` instead; both forms discover the same `alerts` Channel.

Next, send a message from server code. Read [Send from an H3 or Nitro handler](/docs/channels/server-api#send-from-an-h3-or-nitro-handler).
