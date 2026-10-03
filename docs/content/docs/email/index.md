---
title: Email
navigation.title: Overview
description: Send outbound transactional email through a provider-neutral driver contract, with dynamic Markdown composition and safe test capture.
navigation.order: 1
icon: i-lucide-mail
---

Use Email to send transactional messages from server code through ViteHub's Resend or Cloudflare Email drivers, or through a custom programmatic driver. ViteHub configures the driver, normalizes delivery errors, renders trusted Markdown templates, and provides an in-memory test client.

Use [Channels](/docs/channels) when one named destination can deliver through several connectors, such as chat providers.

```ts [server/api/welcome.post.ts]
import { defineEventHandler } from 'h3'
import { email } from 'vite-hub/email/server'

export default defineEventHandler(async () => {
  return await email.send({
    from: 'verified-sender@example.com',
    to: 'you@example.com',
    subject: 'Welcome',
    text: 'Welcome to ViteHub.',
  })
})
```

## Choose the client surface

| Surface | Use it when |
| --- | --- |
| `email.send(message)` | A Vite app configures one built-in provider through `vitehub({ email: { driver, options } })`. |
| `createEmail({ driver })` | Low-level integrations that do not use Vite create and own a client explicitly. |
| `createTestEmail()` | A test needs deterministic in-memory capture without delivery. |
| Development outbox | You want to inspect the messages that `email.send()` sends in `vite dev`. |

## Expose Email to an Agent

Use the official [`email()` Capability](/docs/email/agent-capability) when a model needs to send through the configured Email provider.
The Capability fixes the sender in application code and exposes one plain-text `email_send` tool with optional policy; provider configuration and credentials stay in the [Email configuration](/docs/email/configure).

Dynamic Markdown remains an application composition boundary.
The official Capability doesn't render model-authored Markdown or expose HTML, headers, and attachments. Use a trusted application template or a narrowly scoped Custom Capability for richer messages.
