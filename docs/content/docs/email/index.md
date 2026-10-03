---
title: Email
navigation.title: Overview
description: Send outbound transactional email through a provider-neutral driver contract, with dynamic Markdown composition and safe test capture.
navigation.order: 1
icon: i-lucide-mail
---

::product-hero{tagline="Send transactional email from server code through one message contract. The Vite config selects Resend or Cloudflare Email, and the route does not change."}

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

::

::product-feature{label="Configure" title="The config selects the driver, the runtime keeps the secret" to="/docs/email/configure" link-label="Configure Email"}
Set `driver` to `resend` or `cloudflare-email`. The Env declaration is serialized, but its source value resolves in the server runtime for every send, so the API key stays out of build output. `cloudflare-email` requires Cloudflare hosting and generates an `EMAIL` Worker binding.

For another provider, implement the exported `EmailDriver` interface and pass it to `createEmail()`. Use [Channels](/docs/channels) when one named destination can deliver through several connectors.

#code
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({
    preset: 'node',
    email: {
      driver: 'resend',
      options: { apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }) },
    },
  })],
})
```
::

::product-feature{label="Markdown templates" title="A Markdown file in server/emails becomes a typed import" to="/docs/email/server-api" link-label="Compose dynamic Markdown" reverse}
ViteHub discovers Markdown files under `server/emails` and creates a typed `#vitehub/emails/<name>` import from each path. `renderEmailMarkdown()` renders the composed Markdown to `html` and keeps it as `text`.

Templates are trusted input. `renderEmailMarkdown()` does not sanitize authored HTML, so use scalar `{{ data.value }}` bindings for untrusted text.

#code
```md [server/emails/welcome.md]
# Welcome {{ data.user.name }}

Your workspace is ready.
```

```ts [server/welcome.ts]
import renderWelcome from '#vitehub/emails/welcome'
import { renderEmailMarkdown } from 'vite-hub/email/markdown'
import { email } from 'vite-hub/email/server'

export async function sendWelcome(name: string, to: string) {
  const markdown = await renderWelcome({ user: { name } })
  const body = await renderEmailMarkdown(markdown)

  return await email.send({
    ...body,
    from: 'verified-sender@example.com',
    to,
    subject: 'Your workspace is ready',
  })
}
```
::

::product-feature{label="Development outbox" title="Every send in vite dev is recorded" to="/docs/email/hosts" link-label="Inspect the development outbox"}
In `vite dev`, the outbox records each `email.send()` call and then sends it through the provider. Set `deliver: false` to record messages without a provider request. Build output never contains the outbox.

Inspect the messages from the CLI or in the [Console](/docs/development/console) **Email** section.

#code
```ts [vite.config.ts]
export default defineConfig({
  plugins: [vitehub({
    email: {
      driver: 'resend',
      options: { apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }) },
      outbox: { deliver: false, limit: 100 },
    },
  })],
})
```

```bash [Terminal]
pnpm vitehub email outbox list
pnpm vitehub email outbox show outbox-1 --html > message.html
```
::

::product-feature{label="Tests" title="A test client captures messages without delivery" to="/docs/email/server-api" link-label="Test without delivery" reverse}
`createTestEmail()` returns a client with an isolated in-memory mailbox. Captured messages keep a stable delivery order, and `clear()` empties the mailbox.

Install the `@vite-hub/email` owner package as a development dependency to use it.

#code
```ts [welcome.test.ts]
import { expect, it } from 'vitest'
import { createTestEmail } from '@vite-hub/email/test'

it('sends the welcome message', async () => {
  const mail = createTestEmail()

  await expect(mail.send({
    from: 'hello@example.com',
    to: 'you@example.com',
    subject: 'Welcome',
    text: 'Hello',
  })).resolves.toEqual({ driver: 'memory', id: 'memory-1' })

  expect(mail.messages[0]?.subject).toBe('Welcome')
})
```
::

::product-feature{label="Agent capability" title="An Agent sends plain text to the addresses you allow" to="/docs/email/agent-capability" link-label="Give an Agent the email tool"}
The `email()` Capability gives an Agent one `email_send` tool. The application fixes the sender. Every recipient must match the `recipients` allowlist, or the whole call is denied before the Email primitive runs.

The model cannot set HTML, headers, or attachments. Add `policy: 'require-approval'` to send only after approval.

#code
```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { email } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    email({
      from: 'support@example.com',
      recipients: [
        'customer@example.net',
        'owner@example.com',
      ],
      policy: 'require-approval',
    }),
  ],
})
```
::

::product-feature{label="Errors" title="Every delivery failure has an EMAIL_* code" to="/docs/email/limits-and-errors" link-label="Handle delivery errors" reverse}
ViteHub maps provider errors to stable `EMAIL_*` codes and keeps the original error in `cause`. Inspect `cause` only in protected server-side diagnostics.

Email does not retry. A timeout can occur after the provider accepted the message, so put retry and idempotency policy in [Queue](/docs/queue), [Workflows](/docs/workflows), or the provider adapter.

#code
```ts [server/send.ts]
import { getViteHubErrorShape } from 'vite-hub/runtime'
import { type EmailMessage } from 'vite-hub/email'
import { email } from 'vite-hub/email/server'

export async function send(message: EmailMessage) {
  try {
    return await email.send(message)
  }
  catch (error) {
    const shape = getViteHubErrorShape(error)
    if (shape?.code.startsWith('EMAIL_')) {
      console.error('Email delivery failed', {
        code: shape.code,
        driver: shape.details?.driver,
      })
    }
    throw error
  }
}
```
::
