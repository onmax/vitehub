---
title: Email get started
description: Install Email, configure Resend, and send a first message from server code.
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

## Before you begin

The quick start takes about ten minutes and sends a real message through Resend. You need:

- Node.js 24.15 or later and an existing Vite 8 or later server application.
- pnpm and a POSIX-compatible shell for the commands below.
- A Resend API key and a sender address accepted by Resend.
- A real recipient address you can check.

## Send your first message

::steps{level="3"}

### Install the email dependencies

```bash [Terminal]
pnpm add vite-hub
```

`vite-hub` includes the Email runtime plus built-in Resend and Cloudflare Email drivers.

### Configure Resend

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({
    preset: 'node',
    email: {
      driver: 'resend',
      options: {
        apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }),
      },
    },
  })],
})
```

The stable driver name selects a ViteHub-owned provider implementation. The Env declaration is serialized, but its source value is resolved in the server runtime for every send, so the API key stays out of build output and request-scoped Cloudflare secrets stay current. Literal options and non-secret Env defaults are serialized into the build; never use literal options for credentials, and ViteHub rejects defaults on declarations marked secret.

### Provide the Resend secret

Set `RESEND_API_KEY` in the server process:

```bash [Terminal]
export RESEND_API_KEY='re_...'
```

Use your deployment platform's secret store in production. Do not use a `VITE_` prefix because Vite-prefixed values can be exposed to browser code.

### Send from server code

Replace both addresses with values accepted by Resend. The request performs a real delivery. In `vite dev`, the [development outbox](/docs/email/hosts#development-outbox) also records the message.

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

### Verify the result

Start the application with its normal development command and send a `POST` request to `/api/welcome`. A successful response has this shape:

```json
{
  "id": "<provider-message-id>",
  "driver": "resend"
}
```

Resend supplies `id`. Confirm delivery in the recipient inbox or the provider's delivery log; an accepted message ID does not guarantee final inbox placement.

::
