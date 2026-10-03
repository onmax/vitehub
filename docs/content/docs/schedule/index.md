---
title: Schedule
navigation.title: Overview
description: Declare static cron schedules and manage recurring Runtime Schedules for eligible targets.
navigation.order: 1
icon: i-lucide-calendar-clock
---

Use a Static Schedule Definition for cron entries deployed with the app. Use Runtime Schedules when the app creates, updates, or removes recurring work while it runs.

A Schedule Target can start an Agent Invocation, but Schedule itself runs on the server. Give an Agent schedule access only through a Schedule Capability.

Use Schedule for recurring cron work. Use [Queue](/docs/queue) when a provider-supported enqueue delay is enough, and [Workflows](/docs/workflows) for durable multi-step orchestration.

## Example

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

## Connect Schedule to Agents

The Schedule Capability can let an Agent read or manage allowed Runtime Schedules through Capability policy. Inline Agent Schedules start the owning Agent with Schedule Invocation Input, not a synthetic user message.

Attach a Schedule Capability only when a model needs to manage schedules. Read [Official capabilities](/docs/agents/capabilities/official) for Capability modes and write policy.
