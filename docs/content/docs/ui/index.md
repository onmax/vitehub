---
title: ViteHub UI
description: "Console-ready Vue components for chat, sessions, Agent runs, and code views."
navigation.title: Overview
navigation.order: 1
navigation.group: Start
icon: i-ph-squares-four-light
---

`@vite-hub/ui` is the Vue and Nuxt component layer for ViteHub. It covers the surfaces a Console needs first: chat, sessions, Agent Invocations, traces, diffs, and file trees. The components render AI SDK contracts with sensible Nuxt UI defaults. They do not own transport, persistence, or authorization.

The Console is the reference implementation. The examples on these pages use the same dense layout, spacing, and empty states. They run with synthetic data, make no network requests, and show the source directly below each preview.

::u-page-grid{class="not-prose mt-8 sm:grid-cols-2 lg:grid-cols-3"}
  :::u-page-card
  ---
  title: Install the package
  description: Add the Nuxt module or Vite plugin, then load the shared styles.
  icon: i-lucide-package
  to: /docs/ui/installation
  ---
  :::
  :::u-page-card
  ---
  title: Start with a Console block
  description: Copy a complete chat app, Invocation dashboard, or code review view.
  icon: i-ph-layout-light
  to: /docs/ui/blocks/chat-app
  ---
  :::
  :::u-page-card
  ---
  title: Read the Vue point of view
  description: Why ViteHub UI chooses a small default and a Console-first layout.
  icon: i-simple-icons-vuedotjs
  to: /docs/getting-started/built-for-vue
  ---
  :::
::

## Components

::ui-component-gallery
- **Chat:** [Chat](/docs/ui/chat), [Chat message](/docs/ui/chat-message), [Message parts](/docs/ui/message-parts), [Markdown](/docs/ui/markdown), [Chat prompt](/docs/ui/chat-prompt), [Session](/docs/ui/session)
- **Agent work:** [Invocation list](/docs/ui/invocation-list), [Invocation](/docs/ui/invocation), [Invocation inspector](/docs/ui/invocation-inspector), [Timeline](/docs/ui/timeline), [Capability inspector](/docs/ui/capability-inspector), [Tool list](/docs/ui/tool-list), [Trace](/docs/ui/trace), [Diff](/docs/ui/diff), [Code view](/docs/ui/code-view), [File tree](/docs/ui/file-tree)
- **Utilities:** [Attachments](/docs/ui/attachments), [Message scroller](/docs/ui/message-scroller)
- **Blocks:** [Chat app](/docs/ui/blocks/chat-app), [Invocation dashboard](/docs/ui/blocks/invocation-dashboard), [Code review](/docs/ui/blocks/code-review)
::

## Defaults that travel

| Concern | Owner |
| ------- | ----- |
| Message contracts and transport | AI SDK or your ViteHub Agent route |
| Scroll intent and message jumps | ViteHub headless Vue primitives |
| Tokens and basic controls | Nuxt UI |
| Chat, sessions, Agent inspection, Markdown, and attachments | ViteHub UI |
| Diffs and path-first file trees | Pierre |

The package does not send messages. Use `useChat()` from `@ai-sdk/vue` or the ViteHub wrapper from `vite-hub/agent/vue`, then pass its reactive values to the components.

## Entry points

| Import                    | Use it for                                                                     |
| ------------------------- | ------------------------------------------------------------------------------ |
| `@vite-hub/ui`            | Styled components, composables, display helpers, and Pierre diff helpers.      |
| `@vite-hub/ui/agent-*`    | One styled component entry point, such as `@vite-hub/ui/agent-chat`.            |
| `@vite-hub/ui/headless`   | Message scroller primitives without styles or Nuxt UI.                         |
| `@vite-hub/ui/nuxt`       | The Nuxt module. It installs Nuxt UI, registers components, and loads the CSS. |
| `@vite-hub/ui/vite`       | The Vite plugin for Vue applications. It configures Nuxt UI and Comark.        |
| `@vite-hub/ui/styles.css` | The package stylesheet. Load it after Tailwind CSS and Nuxt UI.                |
