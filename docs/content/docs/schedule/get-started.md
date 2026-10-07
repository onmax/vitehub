---
title: Schedule a daily report
description: Declare a UTC schedule, run it on demand during development, and inspect the generated provider output.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

A Static Schedule is part of your build. The host triggers it at the declared cron time. Start with this path when the schedule is known at deploy time. Runtime Schedules belong in the [Server API](/docs/schedule/server-api) when users need to create or change records while the app runs.

::tutorial-step{title="Install and configure"}
## Install and configure

```bash [Terminal]
pnpm add @vite-hub/schedule
pnpm add -D @vite-hub/cli vite
```

```ts [vite.config.ts]
import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubSchedule()],
})
```

::

::tutorial-step{title="Declare the schedule"}
## Declare the schedule

Create `server/schedules/daily-report.ts`:

```ts [server/schedules/daily-report.ts]
import { defineSchedule } from '@vite-hub/schedule'

export default defineSchedule({
  cron: '0 8 * * *',
  manual: true,
  handler({ scheduledAt }) {
    console.log(`Daily report scheduled for ${scheduledAt.toISOString()}`)
  },
})
```

Static Schedule cron expressions use UTC. `scheduledAt` is the occurrence time chosen by the host. Replace the log with the report work after the manual run succeeds.

::

::tutorial-step{title="Build and inspect"}
## Build and inspect

```bash [Terminal]
pnpm vite build
pnpm vitehub inspect definitions --kind schedule
```

The generated output contains the schedule name and provider wiring. Because `manual: true` is set, run the definition without waiting for 08:00:

```bash [Terminal]
# Terminal 1
pnpm vite dev

# Terminal 2
pnpm vitehub schedule run daily-report --server http://localhost:5173 --json
```

The result includes the run status and the `scheduledAt` value passed to the handler. A provider wake, not the build itself, starts production runs.

::

## Choose the next path

- Keep this Static Schedule when the cron and target are part of the release.
- Use a [Runtime Schedule](/docs/schedule/server-api#create-recurring-runtime-schedules) when users or Agents manage persisted records.
- Read [Hosts](/docs/schedule/hosts) for provider wake output, long-running Node processes, and time zones.
