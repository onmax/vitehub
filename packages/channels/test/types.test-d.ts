import { createChannel, defineOutboundChannel, useChannel } from "../src/index.ts"

interface NamedConnectorOptions {
  destination: string
}

interface DynamicConnectorOptions extends NamedConnectorOptions {
  connector: string
}

declare global {
  interface ViteHubChannelDefinitionModules {
    alerts: { default: typeof definition }
  }
}

const definition = defineOutboundChannel({
  connectors: {
    slack: {
      send: async (_text: string, options: { channelId: string, threadTs?: string }) => ({ id: options.channelId }),
    },
    telegram: {
      send: async (_text: string, options: { chatId: string }) => ({ id: options.chatId }),
    },
  },
})

const channel = createChannel("alerts", definition)

const namedInterfaceChannel = createChannel("named-interface", defineOutboundChannel({
  connectors: {
    webhook: {
      send: async (_text: string, options: NamedConnectorOptions) => ({ id: options.destination }),
    },
  },
}))

namedInterfaceChannel.send("Build finished.", { connector: "webhook", destination: "endpoint-1" })

const metadataChannel = createChannel("metadata-only", defineOutboundChannel({
  connectors: {
    webhook: {
      send: async () => ({ status: "accepted" }),
    },
  },
}))

metadataChannel.send("Build finished.", { connector: "webhook" })

defineOutboundChannel({
  connectors: {
    pingOnly: {
      // @ts-expect-error Connectors must accept every string exposed by Channel.send().
      send: (_text: "ping", _options: NamedConnectorOptions) => ({ status: "accepted" }),
    },
  },
})

defineOutboundChannel({
  connectors: {
    // @ts-expect-error Connector options must be objects because send passes an options object.
    primitiveOptions: {
      send: (_text: string, _options: string) => ({ status: "accepted" }),
    },
  },
})

async function checkSendTuple() {
  const [error, receipt] = await channel.send("Build finished.", { connector: "telegram", chatId: "chat-1" })
  if (error) {
    const absent: null = receipt
    return absent
  }
  const noError: null = error
  const deliveryId: string = receipt.deliveryId
  return { noError, deliveryId }
}
void checkSendTuple

channel.send("Build finished.", { connector: "telegram", chatId: "chat-1" })
channel.send("Build finished.", { connector: "slack", channelId: "channel-1" })

// @ts-expect-error Known connectors reject misspelled option properties.
channel.send("Build finished.", { connector: "telegram", chatId: "chat-1", slient: true })

const defaultChannel = createChannel("defaults", defineOutboundChannel({
  connectors: definition.connectors,
  defaultConnector: "telegram",
}))
defaultChannel.send("Build finished.", { chatId: "chat-1" })

// @ts-expect-error Default connectors reject misspelled option properties.
defaultChannel.send("Build finished.", { chatId: "chat-1", slient: true })

// @ts-expect-error Connector options remain specific to the selected connector.
channel.send("Build finished.", { connector: "telegram", channelId: "channel-1" })

const discovered = useChannel("alerts")
discovered.send("Build finished.", { connector: "telegram", chatId: "chat-1" })

// @ts-expect-error Generated Channel names reject unknown literals.
useChannel("alrets")

const runtimeName: string = "runtime-channel"
const dynamic = useChannel(runtimeName)
dynamic.send("Build finished.", { connector: "runtime", destination: "room-1" })
dynamic.send("Build finished.", {})
const dynamicOptions: DynamicConnectorOptions = { connector: "runtime", destination: "room-1" }
dynamic.send("Build finished.", dynamicOptions)
const dynamicDefaultOptions: NamedConnectorOptions = { destination: "room-1" }
dynamic.send("Build finished.", dynamicDefaultOptions)
dynamic.send("Build finished.", { destination: "room-1" })

// @ts-expect-error Dynamic connector selectors must be strings when present.
dynamic.send("Build finished.", { connector: 42 })

// @ts-expect-error Dynamic channel options must be objects.
dynamic.send("Build finished.", "room-1")

// @ts-expect-error Discovered Channel names retain connector-specific options.
discovered.send("Build finished.", { connector: "telegram", channelId: "channel-1" })
