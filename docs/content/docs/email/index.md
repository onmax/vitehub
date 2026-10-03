---
title: Email
navigation.title: Overview
description: Send outbound transactional email through a provider-neutral driver contract, with dynamic Markdown composition and safe test capture.
navigation.order: 1
icon: i-lucide-mail
---

::product-hero{tagline="One message contract for transactional email: the Vite config selects Resend or Cloudflare Email, and routes stay unchanged."}
  :::code-group
  ```ts [Route]
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

  ```md [Template]
  # Welcome {{ data.user.name }}

  Your workspace is ready.
  ```

  ```ts [Agent]
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
  :::
::

::product-features
  :::product-feature-item{title="Config picks the driver, runtime keeps the secret" icon="i-lucide-sliders-horizontal" to="/docs/email/configure" link-label="Configure Email"}
  Set `driver` to `resend` or `cloudflare-email`, and the API key resolves in the server runtime, not in build output.
  :::

  :::product-feature-item{title="Markdown files in server/emails become typed imports" icon="i-lucide-files" to="/docs/email/server-api#compose-dynamic-markdown" link-label="Compose dynamic Markdown"}
  Each file becomes a `#vitehub/emails/<name>` import, and `renderEmailMarkdown()` renders it to `html` and `text` without sanitizing authored HTML.
  :::

  :::product-feature-item{title="Every send in vite dev is recorded" icon="i-lucide-terminal" to="/docs/email/hosts#development-outbox" link-label="Development outbox"}
  The outbox records each `email.send()` in `vite dev`, and `deliver: false` skips the provider request.
  :::

  :::product-feature-item{title="A test client captures messages without delivery" icon="i-lucide-play-circle" to="/docs/email/server-api#test-without-delivery" link-label="Test without delivery"}
  `createTestEmail()` from `@vite-hub/email/test` returns a client with an isolated in-memory mailbox.
  :::

  :::product-feature-item{title="An Agent sends plain text to allowed addresses" icon="i-lucide-bot" to="/docs/email/agent-capability" link-label="Email capability"}
  The `email()` Capability fixes the sender and denies the whole call when a recipient is not in the `recipients` allowlist.
  :::

  :::product-feature-item{title="Retries belong in Queue or Workflows" icon="i-lucide-circle-alert" to="/docs/queue" link-label="Compare Queue"}
  Email maps failures to `EMAIL_*` codes but does not retry, so put retry and idempotency policy in Queue or Workflows.
  :::
::
