---

title: Send your first Email
description: Install Email, configure Resend, and send a first message from server code.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Email sends a real message through a configured provider. This tutorial uses
Resend and ends with a request you can inspect in the development outbox.

::note
You need Node.js 24.15 or later, Vite 8 or later, `pnpm`, a POSIX-compatible
shell, a Resend API key, a verified sender address, and a recipient address you
can check. The final request sends a real message.
::

::tutorial-step{title="Install the email dependencies"}
## Install the email dependencies

```bash [commands/install]
pnpm add vite-hub nitro h3
pnpm add -D vite
```

`vite-hub` includes the Email runtime plus built-in Resend and Cloudflare Email drivers.

::

::tutorial-step{title="Configure Resend"}
## Configure Resend

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [vitehub({
    preset: 'node',
    email: {
      driver: 'resend',
      options: {
        apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }),
      },
    },
  }), nitro() as never],
})
```

The stable driver name selects a ViteHub-owned provider implementation. The Env declaration is serialized, but its source value is resolved in the server runtime for every send, so the API key stays out of build output and request-scoped Cloudflare secrets stay current. Literal options and non-secret Env defaults are serialized into the build; never use literal options for credentials, and ViteHub rejects defaults on declarations marked secret.

::

::tutorial-step{title="Provide the Resend secret"}
## Provide the Resend secret

Set `RESEND_API_KEY` in the server process:

```bash [commands/secret]
export RESEND_API_KEY='re_...'
```

Use your deployment platform's secret store in production. Do not use a `VITE_` prefix because Vite-prefixed values can be exposed to browser code.

::

::tutorial-step{title="Send from server code"}
## Send from server code

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

::

::tutorial-step{title="Verify the result"}
## Verify the result

Nitro serves the `server/api` route. Start the server and send the request:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. In another terminal, run:

```bash [commands/request]
curl -X POST http://localhost:5173/api/welcome
```

A successful response has this shape:

```json [output/response.json]
{
  "id": "<provider-message-id>",
  "driver": "resend"
}
```

Resend supplies `id`. Confirm delivery in the recipient inbox or the provider's delivery log; an accepted message ID does not guarantee final inbox placement.

::
