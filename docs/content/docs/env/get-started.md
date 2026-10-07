---

title: Read your first environment value
description: Install Env, register the Vite integration, and read the first Public Env value.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Env declares public values at build time and server values at runtime. This
tutorial exposes one safe application name through the generated Public Env
module.

::note
You need Node.js 24.15 or newer, `pnpm`, and an existing Vite server app. Public
values are included in browser output. Keep credentials in `env.server` and
read them only from server code.
::

::tutorial-step{title="Install"}
## Install

```bash [commands/install]
pnpm add @vite-hub/env @vite-hub/runtime
pnpm add -D vite
```

::

::tutorial-step{title="Configure"}
## Configure

```ts [vite.config.ts]
import { env, hubEnv } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubEnv()],
  env: {
    public: {
      appName: env({ default: 'Acme', mode: 'build' }),
    },
  },
})
```

::

::tutorial-step{title="Read the value"}
## Read the value

```ts [src/app.ts]
import { usePublicEnv } from '#vitehub/env/public'

const publicEnv = usePublicEnv()
console.log(publicEnv.appName)
```

::

::tutorial-step{title="Build and verify"}
## Build and verify

Build the app to generate the aliased module and its types:

```bash [commands/build]
pnpm vite build
```

The generated `#vitehub/env/public` module resolves `appName` to `Acme`.

::
