---
title: Run a daily report once with Schedule
description: Declare a UTC schedule and execute one occurrence with the direct runtime API.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

A Static Schedule is part of your build. The host triggers it at the declared cron time. Start with this path when the schedule is known at deploy time. Runtime Schedules belong in the [Server API](/docs/schedule/server-api) when users need to create or change records while the app runs.

::tutorial-step{title="Install"}
## Install

Use Node.js 24.15 or newer. This first run uses the direct execution API with an in-memory run store. It needs no Vite server or hosted scheduler.

Start in an empty directory:

```bash [commands/install]
pnpm init
pnpm pkg set type=module
pnpm add @vite-hub/schedule
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

::tutorial-step{title="Execute one occurrence"}
## Execute one occurrence

Create a script that imports the Definition and executes a fixed occurrence:

```ts [run.ts]
import { executeStaticSchedule } from '@vite-hub/schedule/runtime'
import dailyReport from './server/schedules/daily-report.ts'

const run = await executeStaticSchedule({
  cron: dailyReport.cron,
  definition: dailyReport,
  name: 'daily-report',
  scheduledAt: new Date('2026-08-27T08:00:00.000Z'),
})

console.log(run.status)
```

Node.js can run this TypeScript script directly:

```bash [commands/run]
node run.ts
```

The process prints:

```txt [output/daily-report.txt]
Daily report scheduled for 2026-08-27T08:00:00.000Z
succeeded
```

This proves handler execution and in-memory run bookkeeping. It does not install a recurring wake or produce deployment output. Production runs need a provider wake or a long-lived process runtime. The `vitehub schedule run` development command requires a Nitro Vite host; plain Vite cannot serve that runtime endpoint.

::

## Choose the next path

- Keep this Static Schedule when the cron and target are part of the release.
- Use a [Runtime Schedule](/docs/schedule/server-api#create-recurring-runtime-schedules) when users or Agents manage persisted records.
- Read [Hosts](/docs/schedule/hosts) for provider wake output, long-running Node processes, and time zones.
