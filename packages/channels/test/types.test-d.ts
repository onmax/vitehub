import { createChannel, defineOutboundChannel, useChannel } from "../src/index.ts"

interface NamedConnectorOptions {
  destination: string
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

// @ts-expect-error Discovered Channel names retain connector-specific options.
discovered.send("Build finished.", { connector: "telegram", channelId: "channel-1" })
