---
title: Schedule get started
description: Install Schedule, register the Vite Integration, and declare a first Static Schedule Definition.
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/schedule
```

### Configure

```ts [vite.config.ts]
import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubSchedule()],
})
```

### Start using it

```ts [server/schedules/daily-report.ts]
import { defineSchedule } from '@vite-hub/schedule'

export default defineSchedule({
  cron: '0 8 * * *',
  async handler({ scheduledAt, waitUntil }) {
    await sendDailyReport(scheduledAt)
    waitUntil(recordDelivery())
  },
})
```

::
