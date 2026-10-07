---
title: Read your first environment value
description: Install Env, register the Vite integration, and read the first Public Env value.
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/env @vite-hub/runtime
```

### Configure

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

### Start using it

```ts [src/app.ts]
import { usePublicEnv } from '#vitehub/env/public'

const publicEnv = usePublicEnv()
console.log(publicEnv.appName)
```

::
