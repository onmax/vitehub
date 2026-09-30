
import { defineAgent } from "@vite-hub/agent"
import { telegram } from "@vite-hub/agent/channels"

export default defineAgent({
  channels: {
    telegram: telegram({
      adapter: () => ({}) as never,
      messages: {
        concurrency: "parallel",
        stream: true,
      },
      webhooks: { id: "telegram", secretToken: false },
    }),
  },
  workspace: {},
  driver: {
    run: async () => undefined,
  },
})
