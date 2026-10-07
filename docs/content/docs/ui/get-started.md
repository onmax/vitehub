---
title: Build your first UI view
description: "Install ViteHub UI, render a message, and connect the view to your own chat state."
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
navigation.group: Start
icon: i-lucide-rocket
---

ViteHub UI renders the state that your application owns. This tutorial starts
with one local message, so you can verify the package before adding a model or
an Agent route.

::note
You need Node.js 24.15 or newer, `pnpm`, and a Nuxt application. For a Vue
application that uses Vite, follow [Installation](/docs/ui/installation) first.
::

::tutorial-step{title="Install and configure"}
## Install and configure

Install the UI package and its Nuxt peers:

```bash [commands/install]
pnpm add @vite-hub/ui @nuxt/ui ai tailwindcss vue @iconify-json/lucide @iconify-json/ph
```

Register the module in `nuxt.config.ts`:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["@vite-hub/ui/nuxt"],
});
```

The module loads the package stylesheet and auto-imports the public UI
components. You do not need a Vue plugin registration in Nuxt.
::

::tutorial-step{title="Render one message"}
## Render one message

Create `app.vue` with one user message and one assistant reply:

```vue [app.vue]
<script setup lang="ts">
import type { UIMessage } from "ai";

const messages: UIMessage[] = [
  {
    id: "welcome-user",
    role: "user",
    parts: [{ type: "text", text: "What should I check before a release?" }],
  },
  {
    id: "welcome-assistant",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "Run the build and focused tests, then inspect the preview at the target viewport sizes.",
      },
    ],
  },
];
</script>

<template>
  <AgentChat :messages class="h-[32rem]" />
</template>
```

`AgentChat` renders the AI SDK `UIMessage[]` and keeps scrolling inside its
container. The component does not fetch data or choose an Agent route.
::

::tutorial-step{title="Verify the result"}
## Verify the result

Start Nuxt and open the page:

```bash [commands/dev]
pnpm nuxt dev
```

The page shows the question and the assistant reply. The message viewport has
an accessible name and a scroll control when its content moves away from the
live edge.

Replace the fixture with the reactive values from `useChat()` when you are
ready to send messages:

```bash [commands/install-ai-sdk]
pnpm add @ai-sdk/vue
```

```ts [src/composables/use-chat.ts]
import { useChat } from "@ai-sdk/vue";

const { messages, status, sendMessage, stop } = useChat();
```

Pass those values to [`AgentChat`](/docs/ui/chat) and place
[`AgentChatPrompt`](/docs/ui/chat-prompt) in its `composer` slot. The [Chat
App block](/docs/ui/blocks/chat-app) shows session switching and attachments.
::
