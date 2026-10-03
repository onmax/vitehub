---
title: Schedule
navigation.title: Overview
description: Declare static cron schedules and manage recurring Runtime Schedules for eligible targets.
navigation.order: 1
icon: i-lucide-calendar-clock
---

::product-hero{tagline="Run server code at cron times from a file, or create recurring Runtime Schedules while the app runs. Static schedules become Cloudflare, Vercel, or Deno cron output."}

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

::product-feature{label="Definitions" title="The file is the schedule, the cron is UTC" to="/docs/schedule/configure" link-label="Define a static schedule"}
A Static Schedule Definition deploys with the app. The file name is its identity, and its five-field cron uses UTC.

Set `manual: true` to run it outside its cron with `vitehub schedule run daily-report` or from the Console.

#code
```ts [server/schedules/daily-report.ts]
import { defineSchedule } from '@vite-hub/schedule'

export default defineSchedule({
  cron: '0 8 * * *',
  manual: true,
  async handler() {
    await sendDailyReport()
  },
})
```
::

::product-feature{label="Runtime Schedules" title="Create recurring work while the app runs" to="/docs/schedule/server-api" link-label="Read the Schedule server API" reverse}
`schedules.create()` stores a cron schedule for a target that opted into runtime reuse. Set an IANA `timeZone` when the cron must follow local time and daylight-saving changes.

The same helper lists, updates, pauses, runs, and deletes schedules, and reads their run history.

#code
```ts [server/schedules/report.ts]
import { defineScheduleTarget } from '@vite-hub/schedule'

export default defineScheduleTarget<{ prompt: string }>({
  async handler({ input }) {
    if (input) await generateReport(input.prompt)
  },
})
```

```ts [server/api/schedules.post.ts]
import { schedules } from '@vite-hub/schedule/runtime'

export default defineEventHandler(async () => {
  return schedules.create({
    cron: '30 8 * * 1-5',
    id: 'weekday-report',
    input: { prompt: 'Summarize yesterday' },
    target: 'report',
    timeZone: 'Europe/Copenhagen',
  })
})
```
::

::product-feature{label="Agent capability" title="An Agent can schedule its own turns" to="/docs/schedule/agent-capability" link-label="Give an Agent Schedule tools"}
Attach the Schedule Capability with `mode` to hand an Agent one `cronjob` tool. `targets` limits the schedules it can see and use, and `policy` gates every change.

With `allowSelfTarget`, the Agent creates recurring turns for itself. Each scheduled turn belongs to the invoker that created it.

#code
```ts [server/agents/mini.ts]
import { defineAgent } from 'vite-hub/agent'
import { schedule } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  capabilities: [
    schedule({
      allowSelfTarget: true,
      delivery: 'origin',
      mode: 'write',
      timeZone: 'Asia/Bangkok',
    }),
  ],
})
```
::

::product-feature{label="Process Runtime" title="One long-lived process runs every schedule" to="/docs/schedule/configure" link-label="Configure the Process Runtime" reverse}
On a Node host without provider cron, the Process Runtime scans once per minute. It runs Static Schedule Definitions and stored Runtime Schedules, and keeps them in the default KV store.

It needs exactly one long-lived process. Do not use it on serverless hosts.

#code
```ts [vite.config.ts]
import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubSchedule({
      runtime: {
        driver: 'process',
        prefix: 'my-app:schedule',
      },
    }),
  ],
})
```
::

::product-feature{label="Hosts" title="Inspect schedules and runs from the CLI and the Console" to="/docs/schedule/hosts" link-label="See host and provider notes"}
The development CLI lists Runtime Schedules with their next due time and last run, and runs one on demand. The Console Schedules page shows the same records next to the discovered Definitions.

Use [Queue](/docs/queue) when a provider enqueue delay is enough, and [Workflows](/docs/workflows) for durable multi-step work.

#code
```bash [Terminal]
pnpm vitehub schedule list
pnpm vitehub schedule runs weekday-report --limit 5 --json
pnpm vitehub schedule run-runtime weekday-report
```
::
