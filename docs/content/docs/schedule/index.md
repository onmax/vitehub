---
title: Schedule
navigation.title: Overview
description: Declare static cron schedules and manage recurring Runtime Schedules for eligible targets.
navigation.order: 1
icon: i-lucide-calendar-clock
---

::product-hero{tagline="Run server code at cron times from a file that builds to Cloudflare, Vercel, or Deno cron output."}
  :::code-group
  ```ts [Definition]
  import { defineSchedule } from '@vite-hub/schedule'

  export default defineSchedule({
    cron: '0 8 * * *',
    async handler({ scheduledAt, waitUntil }) {
      await sendDailyReport(scheduledAt)
      waitUntil(recordDelivery())
    },
  })
  ```

  ```ts [Route]
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

  ```ts [Agent]
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

  ```bash [CLI]
  pnpm vitehub schedule list
  pnpm vitehub schedule runs weekday-report --limit 5 --json
  pnpm vitehub schedule run-runtime weekday-report
  ```
  :::
::

::product-features
  :::product-feature-item{title="The file is the schedule, in UTC" icon="i-lucide-code-2" to="/docs/schedule/configure#define-a-static-schedule" link-label="Define a static schedule"}
  A Static Schedule Definition deploys with the app, and `manual: true` lets the CLI or the Console run it outside its cron.
  :::

  :::product-feature-item{title="Create recurring work while the app runs" icon="i-lucide-calendar-clock" to="/docs/schedule/server-api" link-label="Schedule server API"}
  `schedules.create()` stores a cron schedule for an opted-in target, with an IANA `timeZone` when it must follow local time.
  :::

  :::product-feature-item{title="An Agent can schedule its own turns" icon="i-lucide-bot" to="/docs/schedule/agent-capability" link-label="Schedule Agent capability"}
  The Schedule Capability gives an Agent one `cronjob` tool, limited by `targets` and gated by `policy`, and `allowSelfTarget` lets it target itself.
  :::

  :::product-feature-item{title="One long-lived process runs every schedule" icon="i-lucide-cpu" to="/docs/schedule/configure#configure-the-vite-integration" link-label="Configure the Process Runtime"}
  On Node without provider cron, the Process Runtime scans once per minute and needs exactly one long-lived process, never a serverless host.
  :::

  :::product-feature-item{title="Inspect schedules and runs from the CLI" icon="i-lucide-terminal" to="/docs/schedule/hosts" link-label="Schedule hosts"}
  The development CLI lists Runtime Schedules with their next due time and last run, and the Console Schedules page shows the same records.
  :::

  :::product-feature-item{title="Not for delays or multi-step work" icon="i-lucide-git-branch" to="/docs/workflows" link-label="Compare Workflows"}
  Use Queue when a provider enqueue delay is enough, and Workflows for durable multi-step work.
  :::
::
