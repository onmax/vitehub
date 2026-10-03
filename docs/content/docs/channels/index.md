---
title: Channels
navigation.title: Overview
description: Define named server delivery channels and send through a selected connector.
navigation.order: 1
icon: i-lucide-send
---

::product-hero{tagline="Send outbound messages to one named destination from server code. The Channel owns its connectors, and each call site names the connector it uses."}

```ts [server/api/build-finished.post.ts]
import { defineEventHandler } from 'h3'
import { useChannel } from 'vite-hub/channels/server'

export default defineEventHandler(async () => {
  const [error, receipt] = await useChannel('alerts').send('Build finished.', {
    connector: 'telegram',
    chatId: 'build-room',
  })
  if (error) throw error
  return receipt
})
```

::

::product-feature{label="Connectors" title="You write the connector, Channels selects it" to="/docs/channels/get-started" link-label="Define a first Channel"}
ViteHub discovers files below `server/channels` and files that end in `.channel.ts`. The file name is the Channel name. Each connector has a `send()` method with its own options.

Channels does not ship Telegram or Slack adapters and does not generate inbound webhook routes. Call the provider in `send()`, and read Server Env there so the secret resolves at delivery time. `defineOutboundChannel()` replaces the earlier `defineChannel()` export of `vite-hub/channels`, which remains a deprecated alias for one release.

#code
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
::

::product-feature{label="Server API" title="send() returns a result tuple, not a throw" to="/docs/channels/server-api" link-label="Read the Channels server API" reverse}
`send()` returns `[null, receipt]` on success or `[error, null]` on failure. The receipt has the Channel name, the connector name, a ViteHub delivery id, and the optional provider message id.

Add another connector when the same destination can deliver through more than one provider. Keep `connector` explicit at each call site.

#code
```ts
const [error] = await useChannel('alerts').send('Build finished.', {
  connector: 'slack',
  channelId: 'builds',
  threadTs: '1730000000.000100',
})
if (error) throw error
```
::

::product-feature{label="Delivery log" title="Each delivery logs events without the message text" to="/docs/channels/server-api" link-label="Read delivery logging"}
For each connector delivery, Channels writes `outbound.started` and either `outbound.completed` or `outbound.failed` under the `vitehub.channel.send` scope. The events omit message text and connector options. Logging is best effort and does not change the send result.

Channels is outbound only. Use [Agent Channels](/docs/agents/channels) when the destination starts or drives an Agent Invocation, or when inbound custody and recovery are required. Use [Email](/docs/email) for transactional email.

#code
```json
{
  "channel": "alerts",
  "connector": "telegram",
  "deliveryId": "e4875238-2922-4787-9f7f-b13e2e7839be",
  "id": "1730000000000"
}
```
::

::product-feature{label="Agent capability" title="The application picks the recipient, the model writes the message" to="/docs/channels/agent-capability" link-label="Give an Agent Channel delivery" reverse}
`channelDelivery()` gives an Agent one `send_message` tool. The application fixes the Channel and the send options. The model only writes the message, and `validate` can reject it.

`maxCalls` limits the send attempts for each Agent Invocation. With `required: true`, the Invocation fails when the Agent finishes without a successful send.

#code
```ts [server/schedules/weekly-report.ts]
import { defineAgent } from 'vite-hub/agent'
import { channelDelivery } from 'vite-hub/agent/capabilities'
import { useChannel } from 'vite-hub/channels/server'
import bot from '../agents/bot/agent'

const reportAgent = defineAgent({
  extends: bot,
  name: 'weekly-report',
  capabilities: [
    channelDelivery({
      channel: useChannel('teams'),
      options: { recipient: 'user:7b0bff9d' },
      description: 'Send the finished weekly report. Call once.',
      required: true,
    }),
  ],
})
```
::
