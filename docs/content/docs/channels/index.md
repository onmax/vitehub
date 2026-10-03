---
title: Channels
navigation.title: Overview
description: Define named server delivery channels and send through a selected connector.
navigation.order: 1
icon: i-lucide-send
---

`vite-hub/channels` gives server code one named destination for outbound messages. You define the connectors that a Channel can use, then call `useChannel(name).send(text, options)` from an H3 or Nitro handler.

This handler sends one message through the `telegram` connector of the `alerts` Channel:

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

## Know what this primitive includes

Channels provide discovery, connector selection, and a normalized outbound send contract. The current package does not ship Telegram or Slack adapters and does not generate inbound webhook routes; implement those connectors on top of the contract or add them as a later provider package.

`vite-hub/channels` is separate from `vite-hub/agent/channels`. Ordinary Channels send application messages. Agent Channels describe Agent conversation origins, inbound events, and Agent delivery policy; the Agent API stays unchanged.

`defineOutboundChannel()` replaces the earlier `defineChannel()` export of `vite-hub/channels`. That export remains as a deprecated alias for one release so it does not clash with `defineChannel()` from `vite-hub/agent/channels`.

See [Agent Channels](/docs/agents/channels) when the destination starts or drives an Agent Invocation. Use [Email](/docs/email) to send transactional email through a built-in provider.

## Next steps

- [Get started](/docs/channels/get-started): enable discovery and define the first Channel.
- [Server API](/docs/channels/server-api): send messages, read receipts, and add connectors.
- [Agent capability](/docs/channels/agent-capability): let an Agent send its result through a Channel.
