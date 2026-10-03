---
title: Schedule
navigation.title: Overview
description: Declare static cron schedules and manage recurring Runtime Schedules for eligible targets.
navigation.order: 1
icon: i-lucide-calendar-clock
---

::product-hero{providers="Cloudflare, Vercel, Deno, Node.js" tagline="Run server code at cron times from a file that builds to Cloudflare, Vercel, or Deno cron output."}
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

::product-flow{caption="Static schedules run in UTC; Runtime Schedules can follow an IANA timeZone."}
  :::product-flow-step{label="Schedule" detail="defineSchedule · schedules.create()"}
  :::
  :::product-flow-step{label="Wake" detail="Cloudflare · Vercel · Deno.cron · process" loop}
  :::
  :::product-flow-step{label="Handler" detail="handler({ scheduledAt, waitUntil })"}
  :::
  :::product-flow-step{label="Run record" detail="vitehub schedule runs"}
  :::
::

::product-features
  :::product-feature-item{title="The file is the schedule, in UTC" icon="i-lucide-code-2" to="/docs/schedule/configure#define-a-static-schedule"}
  Deploys with the app; `manual: true` allows runs outside the cron.
  :::

  :::product-feature-item{title="Create recurring work while the app runs" icon="i-lucide-calendar-clock" to="/docs/schedule/server-api"}
  `schedules.create()` stores a cron for an opted-in target, with `timeZone`.
  :::

  :::product-feature-item{title="An Agent can schedule its own turns" icon="i-lucide-bot" to="/docs/schedule/agent-capability"}
  One `cronjob` tool, limited by `targets` and gated by `policy`.
  :::

  :::product-feature-item{title="One long-lived process runs every schedule" icon="i-lucide-cpu" to="/docs/schedule/configure#configure-the-vite-integration"}
  On Node, it scans once per minute; never use a serverless host.
  :::

  :::product-feature-item{title="Inspect schedules and runs from the CLI" icon="i-lucide-terminal" to="/docs/schedule/hosts"}
  Lists Runtime Schedules with their next due time and last run.
  :::

  :::product-feature-item{title="Not for delays or multi-step work" icon="i-lucide-git-branch" to="/docs/workflows"}
  Use Queue for enqueue delays, Workflows for durable multi-step work.
  :::
::
